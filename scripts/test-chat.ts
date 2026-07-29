/**
 * 测试多轮 chat。
 *
 *   npm run test:chat -- 你好
 *   npm run test:chat -- --threadId=t1 --knowledgeId=demo 我的项目有哪些？
 */

const base = (process.env.AGENT_BASE_URL || 'http://localhost:7001').replace(
  /\/$/,
  '',
);

function parseArgs(argv: string[]) {
  let knowledgeId: string | undefined;
  let threadId = `chat-${Date.now()}`;
  const messageParts: string[] = [];
  for (const raw of argv) {
    if (raw.startsWith('--knowledgeId=')) knowledgeId = raw.slice(15);
    else if (raw.startsWith('--threadId=')) threadId = raw.slice(11);
    else if (raw === '--help' || raw === '-h') {
      console.log('Usage: npm run test:chat -- [options] <message>');
      process.exit(0);
    } else messageParts.push(raw);
  }
  return {
    knowledgeId,
    threadId,
    message: messageParts.join(' ').trim() || '你好，请介绍你能做什么。',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body: Record<string, unknown> = {
    message: args.message,
    threadId: args.threadId,
  };
  if (args.knowledgeId) body.knowledgeId = args.knowledgeId;

  console.log(`[test:chat] POST ${base}/v1/chat`);
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(data);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
  console.log('\n--- reply ---\n' + (data.reply || ''));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
