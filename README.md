# resume-agent

简历 Agent（Node.js + LangGraph + OpenAI Compatible LLM）。

## 接口

| 路径 | 用途 |
|------|------|
| `POST /v1/analyse` | **简历分析入口**：内部可 ReAct；对外只返回 `{ requestId, knowledgeId?, resume }`（对齐 ResumeDto），不返回调用链 |
| `POST /v1/chat` | **多轮对话入口**：自然语言回复，`threadId` 保持上下文 |
| `GET /health` | 健康检查 |

analyse 不会写 knowledge；`knowledgeId` / `resume` 仅只读上下文。chat 同样只读 knowledge。

## 启动 / 测试

```bash
npm start
npm run test:analyse -- --file=./resume.pdf
npm run test:chat -- 你好
```

## 相关项目

- `../resume-server` — Java API
- `../resume-web` — 前端
