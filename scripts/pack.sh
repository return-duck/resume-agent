#!/usr/bin/env bash
# 仅打包源码与清单文件，不包含 node_modules / .env / data / logs / release
# 服务器上再执行: npm install && ./start.sh
#
# 用法:
#   bash scripts/pack.sh   → release/resume-agent.tar.gz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAME="resume-agent"
OUT_DIR="$ROOT/release"
STAGE="$OUT_DIR/$NAME"
ARCHIVE="$OUT_DIR/${NAME}.tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE"

# 只拷贝运行所需源码与配置模板（绝不打包 node_modules）
for item in \
  package.json \
  package-lock.json \
  tsconfig.json \
  .env.example \
  start.sh \
  README.md \
  src \
  bin \
  scripts
do
  if [ -e "$ROOT/$item" ]; then
    cp -R "$ROOT/$item" "$STAGE/"
  fi
done

chmod +x "$STAGE/start.sh" "$STAGE/bin/resume-agent" "$STAGE/scripts/pack.sh" 2>/dev/null || true

rm -f "$ARCHIVE"
tar -C "$OUT_DIR" -czf "$ARCHIVE" "$NAME"
rm -rf "$STAGE"

echo "打包完成（仅源码，不含 node_modules）:"
echo "  $ARCHIVE"
echo ""
echo "上传后在服务器执行:"
echo "  tar -xzf ${NAME}.tar.gz && cd ${NAME}"
echo "  cp .env.example ../.env   # 放在上一级目录并填写 LLM_*"
echo "  npm install"
echo "  ./start.sh"
