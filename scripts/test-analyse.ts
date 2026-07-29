/**
 * 测试 analyse：对外只应看到 resume 结构 JSON。
 *
 *   npm run test:analyse -- --file=./a.pdf
 *   npm run test:analyse -- --knowledgeId=demo 优化并输出完整简历结构
 */

const base = (process.env.AGENT_BASE_URL || 'http://localhost:7001').replace(
  /\/$/,
  '',
);

function parseArgs(argv: string[]) {
  let knowledgeId: string | undefined;
  let requestId = `test-${Date.now()}`;
  let filePath: string | undefined;
  const messageParts: string[] = [];

  for (const raw of argv) {
    if (raw.startsWith('--knowledgeId=')) {
      knowledgeId = raw.slice('--knowledgeId='.length);
    } else if (raw.startsWith('--requestId=') || raw.startsWith('--threadId=')) {
      requestId = raw.includes('requestId')
        ? raw.slice('--requestId='.length)
        : raw.slice('--threadId='.length);
    } else if (raw.startsWith('--file=')) {
      filePath = raw.slice('--file='.length);
    } else if (raw === '--help' || raw === '-h') {
      console.log(`Usage: npm run test:analyse -- [options] <message>`);
      process.exit(0);
    } else {
      messageParts.push(raw);
    }
  }

  return {
    knowledgeId,
    requestId,
    filePath,
    message:
      messageParts.join(' ').trim() ||
      '请输出完整 Resume JSON（对齐 resume-server ResumeDto）。',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body: Record<string, unknown> = {
    message: args.message,
    requestId: args.requestId,
  };
  if (args.knowledgeId) body.knowledgeId = args.knowledgeId;
  if (args.filePath) body.filePath = args.filePath;

  console.log(`[test:analyse] POST ${base}/v1/analyse`);
  console.log(JSON.stringify(body, null, 2));

  const started = Date.now();
  const res = await fetch(`${base}/v1/analyse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const elapsed = Date.now() - started;
  const data = JSON.parse(text);

  if (!res.ok) {
    console.error(`[test:analyse] HTTP ${res.status} (${elapsed}ms)`, data);
    process.exit(1);
  }

  console.log(`[test:analyse] OK ${elapsed}ms`);
  console.log(JSON.stringify(data, null, 2));
  if (!data.resume) {
    console.error('[test:analyse] 响应缺少 resume 字段');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
