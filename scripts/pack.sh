#!/usr/bin/env bash
# 本机打包，生成可上传的 tar.gz（不含 node_modules / .env / data）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAME="resume-agent"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
STAMP="$(date +%Y%m%d%H%M%S)"
OUT_DIR="$ROOT/release"
STAGE="$OUT_DIR/${NAME}-${VERSION}"
ARCHIVE="$OUT_DIR/${NAME}-${VERSION}-${STAMP}.tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE"

# 需要带上的内容（源码 + 锁文件 + 启动脚本；依赖在服务器 npm install）
for item in \
  package.json \
  package-lock.json \
  tsconfig.json \
  .env.example \
  start.sh \
  README.md \
  src \
  scripts
do
  if [ -e "$ROOT/$item" ]; then
    cp -R "$ROOT/$item" "$STAGE/"
  fi
done

# 排除测试脚本里可能误带的本地路径即可；scripts 可保留 test:*
mkdir -p "$STAGE/data/knowledge" "$STAGE/logs"
printf '%s\n' \
  'node_modules/' \
  '.env' \
  'data/**' \
  'logs/**' \
  > "$STAGE/.gitignore"

# 确保 start.sh 可执行
chmod +x "$STAGE/start.sh" 2>/dev/null || true

tar -C "$OUT_DIR" -czf "$ARCHIVE" "${NAME}-${VERSION}"
rm -rf "$STAGE"

# 同时生成一个固定名软链/拷贝，方便上传
cp -f "$ARCHIVE" "$OUT_DIR/${NAME}-latest.tar.gz"

echo "打包完成:"
echo "  $ARCHIVE"
echo "  $OUT_DIR/${NAME}-latest.tar.gz"
echo ""
echo "上传后在服务器执行:"
echo "  tar -xzf ${NAME}-latest.tar.gz && cd ${NAME}-${VERSION}"
echo "  cp .env.example .env   # 填写 LLM_*"
echo "  npm install"
echo "  ./start.sh"
