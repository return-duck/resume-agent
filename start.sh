#!/usr/bin/env bash
# 生产/服务器启动 resume-agent
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

export PATH="${PATH}:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin"

if [ ! -f ../.env ]; then
  echo "缺少 ../.env，请先在上一级目录: cp resume-agent/.env.example .env 并填写 LLM_*"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js 18+"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "缺少 node_modules，请先执行: npm install"
  exit 1
fi

mkdir -p data/knowledge logs
PORT="${PORT:-7001}"

# 若已有进程，先停掉
if command -v lsof >/dev/null 2>&1; then
  pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${pid:-}" ]; then
    echo "停止占用 $PORT 的进程: $pid"
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
fi

echo "启动 resume-agent on :$PORT ..."
nohup npm start >> logs/agent.log 2>&1 &
echo $! > logs/agent.pid
sleep 1
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "OK  http://127.0.0.1:${PORT}/health"
  echo "PID $(cat logs/agent.pid)  log: logs/agent.log"
else
  echo "启动失败，查看 logs/agent.log"
  tail -n 40 logs/agent.log || true
  exit 1
fi
