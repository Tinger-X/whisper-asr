const Duration = 1000;
let mediaRecorder;
let audioChunks = [];
let sseConnection;
let accumulatedText = "";

let targetProgress = 0;
let currentProgress = 0;
let typewriterTimeout = null;
let displayedTextLength = 0;
let animationStartTime = null;
let animationStartProgress = 0;
let animationStartTextLength = 0;
let targetTextLength = 0;
let animationQueue = [];
let isAnimating = false;

const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const recordBtn = document.getElementById("record-btn");
const stopRecordBtn = document.getElementById("stop-record-btn");
const playPreviewBtn = document.getElementById("play-preview-btn");
const transcribeRecordBtn = document.getElementById("transcribe-record-btn");
const reRecordBtn = document.getElementById("re-record-btn");
const stopBtn = document.getElementById("stop-btn");
const resultArea = document.getElementById("result-area");
const progressBar = document.getElementById("progress-bar");
const processStatus = document.getElementById("process-status");
const recordStatus = document.getElementById("record-status");

let recordedAudioBlob = null;
let recordedAudioUrl = null;
let audioPlayer = null;
let isPlaying = false;

function resetUI() {
    progressBar.style.width = "0%";
    resultArea.textContent = "处理中...";
    processStatus.textContent = "就绪";
    accumulatedText = "";
    targetProgress = 0;
    currentProgress = 0;
    displayedTextLength = 0;
    animationStartTime = null;
    animationStartProgress = 0;
    animationStartTextLength = 0;
    targetTextLength = 0;
    animationQueue = [];
    isAnimating = false;
    if (typewriterTimeout) {
        clearTimeout(typewriterTimeout);
        typewriterTimeout = null;
    }
    if (sseConnection) {
        sseConnection.close();
    }
    uploadBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
}

function queueAnimation(targetProgressValue, targetText) {
    animationQueue.push({
        progress: targetProgressValue,
        text: targetText
    });
    if (!isAnimating) {
        runNextAnimation();
    }
}

function runNextAnimation() {
    if (animationQueue.length === 0) {
        isAnimating = false;
        return;
    }

    isAnimating = true;
    const animation = animationQueue.shift();
    animationStartTime = performance.now();
    animationStartProgress = currentProgress;
    animationStartTextLength = displayedTextLength;
    targetProgress = animation.progress;
    targetTextLength = animation.text.length;

    requestAnimationFrame(animateStep);
}

function animateStep(timestamp) {
    const elapsed = timestamp - animationStartTime;
    const progress = Math.min(elapsed / Duration, 1);

    const easedProgress = easeOutCubic(progress);
    currentProgress = animationStartProgress + (targetProgress - animationStartProgress) * easedProgress;
    progressBar.style.width = `${currentProgress}%`;

    const textProgress = Math.floor(animationStartTextLength + (targetTextLength - animationStartTextLength) * easedProgress);
    if (textProgress > displayedTextLength && textProgress <= targetTextLength) {
        const newText = accumulatedText.substring(0, textProgress);
        resultArea.textContent = newText;
        displayedTextLength = textProgress;
    }

    if (progress < 1) {
        requestAnimationFrame(animateStep);
    } else {
        currentProgress = targetProgress;
        progressBar.style.width = `${targetProgress}%`;
        displayedTextLength = targetTextLength;
        resultArea.textContent = accumulatedText.substring(0, targetTextLength);
        runNextAnimation();
    }
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function connectSSE(taskId) {
    sseConnection = new EventSource(`/sse?task_id=${taskId}`);

    sseConnection.addEventListener("connect", (event) => {
        console.log("SSE连接已建立");
        processStatus.textContent = "已连接...";
    });

    sseConnection.addEventListener("loading", (event) => {
        const progress = JSON.parse(event.data);
        queueAnimation(progress, accumulatedText);
        processStatus.textContent = "加载音频并预处理中...";
    });

    sseConnection.addEventListener("lang", (event) => {
        const [progress, lang] = JSON.parse(event.data);
        queueAnimation(progress, accumulatedText);
        const langNames = {
            "zh": "中文", "en": "英文", "ja": "日语", "ko": "韩语",
            "fr": "法语", "de": "德语", "es": "西班牙语", "ru": "俄语",
            "pt": "葡萄牙语", "it": "意大利语", "nl": "荷兰语", "ar": "阿拉伯语"
        };
        processStatus.textContent = `语言检测完成：${langNames[lang] || lang}`;
    });

    sseConnection.addEventListener("progress", (event) => {
        const [progress, segment] = JSON.parse(event.data);
        processStatus.textContent = "转写中...";
        if (segment) {
            accumulatedText += segment;
            queueAnimation(progress, accumulatedText);
        }
    });

    sseConnection.addEventListener("complete", (event) => {
        queueAnimation(100, accumulatedText);
        processStatus.textContent = "转写完成";
        setTimeout(() => {
            sseConnection.close();
            uploadBtn.disabled = false;
            stopBtn.disabled = true;
            recordBtn.disabled = false;
            stopRecordBtn.disabled = true;
        }, Duration);
    });

    sseConnection.addEventListener("stopped", (event) => {
        processStatus.textContent = "转写已停止";
        sseConnection.close();
        uploadBtn.disabled = false;
        stopBtn.disabled = true;
        recordBtn.disabled = false;
        stopRecordBtn.disabled = true;
    });

    sseConnection.addEventListener("asr-err", (event) => {
        const errorMsg = JSON.parse(event.data);
        processStatus.textContent = "转写失败";
        resultArea.textContent = `错误：${errorMsg}`;
        sseConnection.close();
        uploadBtn.disabled = false;
        stopBtn.disabled = true;
        recordBtn.disabled = false;
        stopRecordBtn.disabled = true;
    });

    sseConnection.onerror = (event) => {
        if (event.eventPhase === EventSource.CLOSED) {
        } else {
            processStatus.textContent = "连接出错";
            console.error("SSE连接错误:", event);
            sseConnection.close();
        }
    };
}

uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) {
        alert("请先选择音频文件！");
        return;
    }

    resetUI();
    processStatus.textContent = "正在上传并处理音频...";
    uploadBtn.disabled = true;
    stopBtn.disabled = false;
    recordBtn.disabled = true;
    stopRecordBtn.disabled = true;

    const formData = new FormData();
    formData.append("file", file);

    try {
        const response = await fetch("/transcribe", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "转写失败");
        }

        const result = await response.json();
        if (result.task_id) {
            connectSSE(result.task_id);
        } else {
            throw new Error("未能获取任务ID");
        }
    } catch (error) {
        processStatus.textContent = "转写失败";
        resultArea.textContent = `错误：${error.message}`;
        console.error(error);
        if (sseConnection) sseConnection.close();
        uploadBtn.disabled = false;
        stopBtn.disabled = true;
        recordBtn.disabled = false;
    }
});

recordBtn.addEventListener("click", async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.start(1000);
        recordBtn.disabled = true;
        stopRecordBtn.disabled = false;
        uploadBtn.disabled = true;
        stopBtn.disabled = true;
        recordStatus.textContent = "正在录音...";
        resultArea.textContent = "正在录音，请说话...";
    } catch (error) {
        alert("无法访问麦克风！请检查权限设置。");
        console.error(error);
    }
});

stopBtn.addEventListener("click", async () => {
    if (sseConnection && sseConnection.readyState === EventSource.OPEN) {
        const taskId = new URLSearchParams(sseConnection.url.split("?")[1]).get("task_id");
        if (taskId) {
            try {
                await fetch(`/stop?task_id=${taskId}`, { method: "POST" });
            } catch (error) {
                console.error("停止转写失败:", error);
                sseConnection.close();
                uploadBtn.disabled = false;
                stopBtn.disabled = true;
                recordBtn.disabled = false;
            }
        }
    }
});

function bufferToWav(audioBuffer) {
    const numOfChan = audioBuffer.numberOfChannels;
    const length = audioBuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let offset = 0;
    let pos = 0;

    setUint32(0x46464952);
    setUint32(length - 8);
    setUint32(0x45564157);

    setUint32(0x20746d66);
    setUint32(16);
    setUint16(1);
    setUint16(numOfChan);
    setUint32(audioBuffer.sampleRate);
    setUint32(audioBuffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2);
    setUint16(16);

    setUint32(0x61746164);
    setUint32(length - pos - 4);

    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
        channels.push(audioBuffer.getChannelData(i));
    }

    while (pos < length) {
        for (let i = 0; i < numOfChan; i++) {
            let sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset++;
    }

    return new Blob([buffer], { type: "audio/wav" });

    function setUint16(data) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data) {
        view.setUint32(pos, data, true);
        pos += 4;
    }
}

async function processRecording(audioChunks) {
    if (!audioChunks || audioChunks.length === 0) {
        throw new Error("没有录音数据，请先开始录音");
    }

    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    const arrayBuffer = await audioBlob.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
        throw new Error("录音数据为空，请重新录音");
    }

    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        const wavBlob = bufferToWav(audioBuffer);
        return new File([wavBlob], "recorded_audio.wav", { type: "audio/wav" });
    } catch (decodeError) {
        console.error("音频解码失败:", decodeError);
        throw new Error("音频解码失败，可能是录音数据损坏或格式不支持");
    }
}

stopRecordBtn.addEventListener("click", async () => {
    if (!mediaRecorder) return;

    mediaRecorder.requestData();
    mediaRecorder.stop();
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    recordStatus.textContent = "";

    mediaRecorder.stream.getTracks().forEach(track => track.stop());

    try {
        if (!audioChunks || audioChunks.length === 0) {
            throw new Error("没有录音数据，请先开始录音后再停止");
        }

        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const arrayBuffer = await audioBlob.arrayBuffer();

        if (arrayBuffer.byteLength === 0) {
            throw new Error("录音数据为空，请重新录音");
        }

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        const wavBlob = bufferToWav(audioBuffer);
        recordedAudioBlob = new File([wavBlob], "recorded_audio.wav", { type: "audio/wav" });

        if (recordedAudioUrl) {
            URL.revokeObjectURL(recordedAudioUrl);
        }
        recordedAudioUrl = URL.createObjectURL(recordedAudioBlob);

        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer = null;
        }
        audioPlayer = new Audio(recordedAudioUrl);
        isPlaying = false;

        audioPlayer.onended = () => {
            isPlaying = false;
            playPreviewBtn.textContent = "▶ 试听录音";
        };

        playPreviewBtn.style.display = "inline-block";
        transcribeRecordBtn.style.display = "inline-block";
        reRecordBtn.style.display = "inline-block";
        stopRecordBtn.style.display = "none";
        recordBtn.style.display = "none";

        progressBar.style.width = "0%";
        resultArea.textContent = "录音完成！点击「试听录音」播放，或点击「转写录音」开始转写。";
        processStatus.textContent = "就绪";

    } catch (error) {
        console.error(error);
        resultArea.textContent = `录音处理失败：${error.message}，请重新尝试录音`;
        processStatus.textContent = "录音失败";
        recordBtn.disabled = false;
    }
});

playPreviewBtn.addEventListener("click", () => {
    if (!audioPlayer) return;

    if (isPlaying) {
        audioPlayer.pause();
        playPreviewBtn.textContent = "▶ 试听录音";
        isPlaying = false;
    } else {
        audioPlayer.play();
        playPreviewBtn.textContent = "⏸ 暂停播放";
        isPlaying = true;
    }
});

transcribeRecordBtn.addEventListener("click", async () => {
    if (!recordedAudioBlob) {
        resultArea.textContent = "没有录音数据";
        return;
    }

    playPreviewBtn.style.display = "none";
    transcribeRecordBtn.style.display = "none";
    reRecordBtn.style.display = "none";
    recordBtn.style.display = "inline-block";
    stopRecordBtn.style.display = "inline-block";

    resetUI();
    processStatus.textContent = "正在转写...";
    resultArea.textContent = "正在转写...";

    try {
        const formData = new FormData();
        formData.append("file", recordedAudioBlob);

        const response = await fetch("/transcribe", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "转写失败");
        }

        const result = await response.json();
        if (result.task_id) {
            connectSSE(result.task_id);
        } else {
            throw new Error("未能获取任务ID");
        }
    } catch (error) {
        processStatus.textContent = "转写失败";
        resultArea.textContent = `错误：${error.message}`;
        console.error(error);
        if (sseConnection) sseConnection.close();
        uploadBtn.disabled = false;
        stopBtn.disabled = true;
        recordBtn.disabled = false;
    }
});

reRecordBtn.addEventListener("click", () => {
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer = null;
    }
    if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
        recordedAudioUrl = null;
    }
    recordedAudioBlob = null;
    isPlaying = false;
    audioChunks = [];

    playPreviewBtn.style.display = "none";
    transcribeRecordBtn.style.display = "none";
    reRecordBtn.style.display = "none";
    stopRecordBtn.style.display = "inline-block";
    recordBtn.style.display = "inline-block";
    recordBtn.disabled = false;
    stopRecordBtn.disabled = true;

    progressBar.style.width = "0%";
    resultArea.textContent = "可以重新开始录音...";
    processStatus.textContent = "就绪";
    recordStatus.textContent = "";
});
