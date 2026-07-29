# resume-agent

简历优化 Agent（Node.js + LangGraph + OpenAI Compatible LLM）。

## 依赖

- Node.js 18+
- LLM API Key（OpenAI Compatible）

## 配置

```bash
cp .env.example .env
# 编辑 .env：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / PORT
```

## 启动

```bash
npm install
npm start
```

默认监听 `http://localhost:7001`。

Java 服务端通过 `AGENT_BASE_URL` 调用本服务。

## 相关项目

- `../resume-server` — Java API
- `../resume-web` — 前端
