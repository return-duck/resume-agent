#!/usr/bin/env bash
# 本机打包当前代码（不含 node_modules / .env / data）
# 用法:
#   bash scripts/pack.sh          → tar.gz
#   bash scripts/pack.sh --zip    → zip
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FORMAT=tar
if [ "${1:-}" = "--zip" ] || [ "${1:-}" = "zip" ]; then
  FORMAT=zip
fi

NAME="resume-agent"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
STAMP="$(date +%Y%m%d%H%M%S)"
OUT_DIR="$ROOT/release"
STAGE="$OUT_DIR/${NAME}-${VERSION}"

rm -rf "$STAGE"
mkdir -p "$STAGE"

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

mkdir -p "$STAGE/data/knowledge" "$STAGE/logs"
printf '%s\n' \
  'node_modules/' \
  '.env' \
  'data/**' \
  'logs/**' \
  > "$STAGE/.gitignore"

chmod +x "$STAGE/start.sh" 2>/dev/null || true

if [ "$FORMAT" = "zip" ]; then
  ARCHIVE="$OUT_DIR/${NAME}-${VERSION}-${STAMP}.zip"
  LATEST="$OUT_DIR/${NAME}-latest.zip"
  (
    cd "$OUT_DIR"
    rm -f "$ARCHIVE"
    zip -qry "$ARCHIVE" "${NAME}-${VERSION}"
  )
  EXTRACT_HINT="unzip ${NAME}-latest.zip && cd ${NAME}-${VERSION}"
else
  ARCHIVE="$OUT_DIR/${NAME}-${VERSION}-${STAMP}.tar.gz"
  LATEST="$OUT_DIR/${NAME}-latest.tar.gz"
  tar -C "$OUT_DIR" -czf "$ARCHIVE" "${NAME}-${VERSION}"
  EXTRACT_HINT="tar -xzf ${NAME}-latest.tar.gz && cd ${NAME}-${VERSION}"
fi

rm -rf "$STAGE"
cp -f "$ARCHIVE" "$LATEST"

echo "打包完成:"
echo "  $ARCHIVE"
echo "  $LATEST"
echo ""
echo "上传后在服务器执行:"
echo "  $EXTRACT_HINT"
echo "  cp .env.example .env   # 填写 LLM_*"
echo "  npm install"
echo "  ./start.sh"
