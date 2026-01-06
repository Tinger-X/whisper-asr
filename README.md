# Whisper 语音转写服务

基于 OpenAI Whisper 模型的语音识别服务，支持实时流式转写（SSE）和直接返回转写结果两种模式。

## 功能特性

- **文件上传转写**：支持 MP3、WAV、M4A、FLAC、OGG、MP4、WebM 等音频格式
- **网页录音**：可以直接在浏览器中录音并实时转写
- **流式返回**：通过 SSE 实时推送转写进度和结果
- **直接返回**：通过 `/api` 接口直接返回完整转写结果
- **停止转换**：支持在转写过程中随时停止任务
- **多语言支持**：自动检测语言，支持中文、英文、日语、韩语等

## 技术栈

- 后端：FastAPI + uvicorn
- 语音识别：OpenAI Whisper
- 前端：原生 HTML/JavaScript
- 设备支持：自动检测 CUDA/GPU 或 CPU

## 部署方式

### 1. 安装依赖

安装uv，教程略。

同步环境：
```bash
uv sync
```

### 2. 启动服务

```bash
uv run main.py
```

服务默认在 `http://0.0.0.0:8000` 启动。

## 访问方式

### Web 界面

直接在浏览器中访问：`http://localhost:8000`

### API 接口

#### 1. 流式转写接口 (`/transcribe`)

返回任务 ID，通过 SSE 获取实时进度。

**请求方式**：POST  
**Content-Type**：multipart/form-data  
**参数**：
- `file`：音频文件

**响应示例**：
```json
{
  "status": "processing",
  "task_id": "abc12345",
  "message": "转写任务已启动"
}
```

#### 2. 停止转写接口 (`/stop`)

停止指定的转写任务。

**请求方式**：POST  
**参数**（Query）：
- `task_id`：任务 ID

**响应示例**：
```json
{
  "status": "stopped",
  "task_id": "abc12345"
}
```

#### 3. 直接转写接口 (`/api`)

直接返回完整转写结果，不通过 SSE 流式返回。

**请求方式**：POST  
**Content-Type**：multipart/form-data  
**参数**：
- `file`：音频文件

**响应示例**：
```json
{
  "status": "success",
  "text": "这是转写的文本内容",
  "language": "zh",
  "language_name": "中文"
}
```

## 前端界面使用说明

1. **上传音频文件转写**：
   - 点击"选择文件"按钮选择音频文件
   - 点击"开始转写"按钮开始转写
   - 实时查看转写进度和结果
   - 可以随时点击"停止转写"按钮中断转写

2. **网页录音转写**：
   - 点击"开始录音"按钮开始录音
   - 说话完毕后点击"停止录音并转写"按钮
   - 系统会自动将录音转换为文字

## SSE 事件类型

连接 `/sse?task_id=xxx` 会收到以下事件：

| 事件类型 | 说明 |
|---------|------|
| `connect` | 连接建立，返回任务 ID |
| `loading` | 加载音频文件阶段 |
| `lang` | 语言检测完成 |
| `progress` | 转写进度更新 |
| `complete` | 转写完成 |
| `stopped` | 转写已停止 |
| `error` | 发生错误 |

## 文件结构

```
audio/
├── main.py           # FastAPI 后端服务
├── static/
│   ├── index.html    # 前端页面
│   ├── en.mp3        # 示例音频（英文）
│   ├── zh.mp3        # 示例音频（中文）
│   └── long.mp3      # 示例音频（长音频）
├── pyproject.toml    # 项目配置
└── README.md         # 说明文档
```

## 注意事项

- 首次启动会自动下载 Whisper 模型（约 140MB）
- GPU 模式下转写速度更快，CPU 模式下可能需要更长时间
- 临时文件会在转写完成后 10 秒自动清理
