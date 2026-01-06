import os
import json
import time
import torch
import zhconv
import whisper
import uvicorn
import asyncio
import tempfile
import threading
from uuid import uuid4
from typing import AsyncGenerator, Dict, Optional
from whisper.tokenizer import get_tokenizer
from whisper.decoding import DecodingOptions
from whisper.audio import N_FRAMES, pad_or_trim
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse, Response


app = FastAPI(
    title="Whisper语音识别SSE服务",
    description="支持文件上传/录音、SSE实时返回转写结果和进度",
    version="1.0.0"
)
device = "cuda" if torch.cuda.is_available() else "cpu"
model = whisper.load_model("base", download_root="./static", device=device, in_memory=True)
task_states: Dict[str, Dict] = {}
active_threads: Dict[str, threading.Thread] = {}


async def sse_generator(task_id: str) -> AsyncGenerator[str, None]:
    """SSE生成器，实时推送转写状态"""
    task_state = task_states.get(task_id)
    
    if not task_state:
        yield f"event: error\ndata: {json.dumps('无效的任务ID')}\n\n"
        return
    
    try:
        yield f"event: connect\ndata: {json.dumps(task_id)}\n\n"
        
        last_progress = -1
        last_segment_text = ""
        last_language = ""
        while True:
            if task_state.get("stopped", False):
                yield f"event: stopped\ndata: {json.dumps('转写已停止')}\n\n"
                task_states.pop(task_id, None)
                if task_id in active_threads:
                    active_threads.pop(task_id, None)
                break
            
            error_msg = task_state.get("error", "")
            if error_msg != "":
                yield f"event: error\ndata: {json.dumps(error_msg)}\n\n"
                task_states.pop(task_id, None)
                break
            
            progress_value = task_state.get("progress", 0)
            is_complete = task_state.get("complete", False)
            segment_text = task_state.get("segment_text", "")
            segment_changed = segment_text != last_segment_text and segment_text
            if is_complete:
                if segment_changed:
                    yield f"event: progress\ndata: {json.dumps([progress_value, segment_text])}\n\n"
                yield f"event: complete\ndata: \n\n"
                task_states.pop(task_id, None)
                if task_id in active_threads:
                    active_threads.pop(task_id, None)
                break

            if progress_value == last_progress:
                await asyncio.sleep(0.05)
                continue
            
            stage = task_state.get("stage", "")
            if stage == "loading":
                yield f"event: loading\ndata: {json.dumps(progress_value)}\n\n"
                last_progress = progress_value
            elif stage == "language":
                detected_language = task_state.get("language", "")
                if detected_language != last_language:
                    yield f"event: lang\ndata: {json.dumps([progress_value, detected_language])}\n\n"
                    last_language = detected_language
                    last_progress = progress_value
            elif stage == "transcribing":
                if segment_changed:
                    yield f"event: progress\ndata: {json.dumps([progress_value, segment_text])}\n\n"
                    last_segment_text = segment_text
                    last_progress = progress_value

            await asyncio.sleep(0.05)
    except asyncio.CancelledError:
        yield f"event: stopped\ndata: {json.dumps('转写已停止')}\n\n"
        task_states.pop(task_id, None)
        if task_id in active_threads:
            active_threads.pop(task_id, None)
    except Exception as e:
        yield f"event: error\ndata: {json.dumps(str(e))}\n\n"
        task_states.pop(task_id, None)
        if task_id in active_threads:
            active_threads.pop(task_id, None)


def transcribe_audio_task(audio_path: str, task_id: str):
    """同步转写任务，更新指定任务的状态"""
    task_state = task_states.get(task_id)
    
    if not task_state:
        return
    
    try:
        task_state["stage"] = "loading"
        task_state["progress"] = 5
        time.sleep(0.1)
        audio = whisper.load_audio(audio_path)
        mel = whisper.log_mel_spectrogram(audio).to(model.device)

        task_state["stage"] = "language"
        task_state["progress"] = 15
        mel_for_lang = pad_or_trim(mel, N_FRAMES).to(model.device)
        _, probs = model.detect_language(mel_for_lang)
        detected_language = max(probs, key=probs.get)
        task_state["language"] = detected_language
        time.sleep(0.1)

        task_state["stage"] = "transcribing"
        task_state["progress"] = 20
        dtype = torch.float32
        total_frames = mel.shape[-1]
        language = detected_language
        task = "transcribe"
        tokenizer = get_tokenizer(
            model.is_multilingual,
            num_languages=model.num_languages,
            language=language,
            task=task,
        )
        
        seek = 0
        while seek < total_frames:
            if task_state.get("stopped", False):
                return
            
            segment_size = min(N_FRAMES, total_frames - seek)
            mel_segment = mel[:, seek : seek + segment_size]
            mel_segment = pad_or_trim(mel_segment, N_FRAMES).to(model.device).to(dtype)
            
            options = DecodingOptions(
                language=language,
                task=task,
                fp16=False,
                temperature=0.0,
            )
            
            result = model.decode(mel_segment, options)
            tokens = result.tokens
            text_tokens = [token for token in tokens if token < tokenizer.eot]
            segment_text = tokenizer.decode(text_tokens).strip()
            
            if segment_text:
                if language in ["zh", "zh-TW", "zh-Hant"]:
                    segment_text = zhconv.convert(segment_text, 'zh-cn')
                task_state["segment_text"] = segment_text
            
            seek += segment_size
            progress_pct = 20 + int((seek / total_frames) * 80)
            task_state["progress"] = progress_pct

        task_state["progress"] = 100
        task_state["complete"] = True

    except Exception as e:
        task_state["error"] = str(e)
        task_state["complete"] = True


@app.get("/", include_in_schema=False)
async def root():
    with open("./static/index.html", "r", encoding="utf-8") as f:
        html_content = f.read()
    return Response(content=html_content, media_type="text/html")


@app.get("/sse")
async def sse_endpoint(task_id: str = Query(..., description="任务ID")):
    if task_id not in task_states:
        return StreamingResponse(
            (f"event: error\ndata: {json.dumps({'error': '无效的任务ID或任务已过期'})}\n\n",),
            media_type="text/event-stream"
        )
    return StreamingResponse(
        sse_generator(task_id),
        media_type="text/event-stream"
    )


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(..., description="音频文件")):
    """语音转写接口"""
    task_id = str(uuid4())[:8]
    
    task_states[task_id] = {
        "progress": 0,
        "message": "",
        "text": "",
        "complete": False,
        "error": ""
    }

    # 校验文件类型
    allowed_extensions = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".webm"]
    file_ext = os.path.splitext(file.filename)[1].lower()
    if file_ext not in allowed_extensions:
        task_states[task_id]["error"] = f"不支持的文件格式！仅支持：{allowed_extensions}"
        task_states[task_id]["complete"] = True
        raise HTTPException(status_code=400, detail=f"不支持的文件格式！仅支持：{allowed_extensions}")

    try:
        # 保存临时文件
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as temp_file:
            temp_file.write(await file.read())
            temp_file_path = temp_file.name

        # 后台执行转写
        asyncio.create_task(asyncio.to_thread(transcribe_audio_task, temp_file_path, task_id))

        return JSONResponse(content={"status": "processing", "task_id": task_id, "message": "转写任务已启动"})

    except Exception as e:
        task_states[task_id]["error"] = str(e)
        task_states[task_id]["complete"] = True
        raise HTTPException(status_code=500, detail=f"转写失败：{str(e)}")

    finally:
        # 延迟清理临时文件
        async def cleanup_temp_file(path):
            await asyncio.sleep(10)
            if os.path.exists(path):
                os.remove(path)

        if 'temp_file_path' in locals():
            asyncio.create_task(cleanup_temp_file(temp_file_path))


@app.post("/stop")
async def stop_transcription(task_id: str = Query(..., description="任务ID")):
    """停止指定的转写任务"""
    if task_id not in task_states:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "任务不存在或已结束"}
        )
    
    task_states[task_id]["stopped"] = True
    
    if task_id in active_threads:
        thread = active_threads[task_id]
        if thread.is_alive():
            # 通过设置停止标志来终止线程
            pass
    
    return JSONResponse(content={"status": "stopped", "task_id": task_id})


@app.post("/api")
async def transcribe_api(file: UploadFile = File(..., description="音频文件")):
    """直接返回转写结果（非流式）"""
    allowed_extensions = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".webm"]
    file_ext = os.path.splitext(file.filename)[1].lower()
    if file_ext not in allowed_extensions:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式！仅支持：{allowed_extensions}")

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as temp_file:
            temp_file.write(await file.read())
            temp_file_path = temp_file.name

        audio = whisper.load_audio(temp_file_path)
        mel = whisper.log_mel_spectrogram(audio).to(model.device)
        mel_for_lang = pad_or_trim(mel, N_FRAMES).to(model.device)
        _, probs = model.detect_language(mel_for_lang)
        detected_language = max(probs, key=probs.get)
        
        language = detected_language
        task = "transcribe"
        tokenizer = get_tokenizer(
            model.is_multilingual,
            num_languages=model.num_languages,
            language=language,
            task=task,
        )
        
        total_frames = mel.shape[-1]
        accumulated_text = ""
        seek = 0
        
        while seek < total_frames:
            segment_size = min(N_FRAMES, total_frames - seek)
            mel_segment = mel[:, seek : seek + segment_size]
            mel_segment = pad_or_trim(mel_segment, N_FRAMES).to(model.device)
            
            options = DecodingOptions(
                language=language,
                task=task,
                fp16=False,
                temperature=0.0,
            )
            
            result = model.decode(mel_segment, options)
            tokens = result.tokens
            text_tokens = [token for token in tokens if token < tokenizer.eot]
            segment_text = tokenizer.decode(text_tokens).strip()
            
            if segment_text:
                if language in ["zh", "zh-TW", "zh-Hant"]:
                    segment_text = zhconv.convert(segment_text, 'zh-cn')
                accumulated_text += segment_text
            
            seek += segment_size
        
        lang_names = {
            'zh': '中文', 'en': '英文', 'ja': '日语', 'ko': '韩语',
            'fr': '法语', 'de': '德语', 'es': '西班牙语', 'ru': '俄语',
            'pt': '葡萄牙语', 'it': '意大利语', 'nl': '荷兰语', 'ar': '阿拉伯语'
        }
        
        return JSONResponse(content={
            "status": "success",
            "text": accumulated_text,
            "language": detected_language,
            "language_name": lang_names.get(detected_language, detected_language)
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"转写失败：{str(e)}")
    
    finally:
        if 'temp_file_path' in locals() and os.path.exists(temp_file_path):
            os.remove(temp_file_path)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)