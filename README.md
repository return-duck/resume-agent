# resume-agent

简历 Agent（Node.js + LangGraph + OpenAI Compatible LLM）。

## 接口

| 路径 | 用途 |
|------|------|
| `POST /v1/analyse` | **简历分析（oneshot）**：①代码抽草稿 → ②并行单次 LLM → ③合并；返回 `{ requestId, knowledgeId?, resume, mode }` |
| `POST /v1/analyse-react` | **同上顺序**，但 refine_* 用 ReAct（`createReactAgent` + tools） |
| `POST /v1/chat` | **多轮对话入口**：自然语言回复，`threadId` 保持上下文 |
| `GET /health` | 健康检查 |

analyse / analyse-react 不会写 knowledge；`knowledgeId` / `resume` 仅只读上下文。chat 同样只读 knowledge。

## CLI

```bash
npm run cli -- help
npm run cli -- start                          # 启动 HTTP 服务
npm run cli -- analyse --file=./resume.pdf    # 并行单次 LLM
npm run cli -- analyse-react --file=./a.pdf   # 同序 ReAct
npm run cli -- chat                           # 交互对话
npm run cli -- pack --zip                     # 打包源码
```

也可：`npx resume-agent <command>` / `./bin/resume-agent <command>`

## 启动 / 测试

```bash
npm start
npm run test:analyse -- --file=./resume.pdf   # 经 HTTP 测 analyse
npm run test:chat -- 你好

# oneshot vs react 各跑 N 次，输出 bench/analyse-compare-*.md
npm run bench:analyse -- --runs=20
npm run bench:analyse -- --runs=2 --file="/path/to/a.pdf"
```

## 相关项目

- `../resume-server` — Java API
- `../resume-web` — 前端
