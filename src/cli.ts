/**
 * resume-agent CLI
 *
 *   npm run cli -- start
 *   npm run cli -- analyse --file=./resume.pdf
 *   npm run cli -- chat
 *   npm run cli -- pack
 *   npx resume-agent <command>
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { loadEnvFile } from './loadEnv.js';
import {
  getKnowledgeDir,
  loadKnowledgeFromDisk,
} from './knowledge/store.js';
import { extractTextFromBuffer } from './parsers/document.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function printHelp() {
  console.log(`resume-agent CLI

用法:
  resume-agent <command> [options]

命令:
  start                 启动 HTTP 服务
  analyse [options] [message]
                        简历分析（并行单次 LLM）
  analyse-react [options] [message]
                        同上顺序，refine 用 ReAct + tools
  chat [options] [message]
                        多轮对话；无 message 时进入交互模式
  pack                  打包源码为 tar.gz（不含 node_modules）
  help                  显示帮助

analyse / analyse-react 选项:
  --file=<path> | --file <path>   本地简历文件（pdf/docx/txt/md）
                                  路径含空格时请加引号
  --knowledgeId=<id>              只读 knowledge
  --requestId=<id>                请求 ID

chat 选项:
  --threadId=<id>       会话 ID（默认自动生成）
  --knowledgeId=<id>    只读 knowledge

示例:
  npm run cli -- start
  npm run cli -- analyse --file=./a.pdf
  npm run cli -- analyse-react --file=./a.pdf
  npm run cli -- chat --threadId=t1 你好
  npm run pack
`);
}

function takeFlags(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
    } else if (raw.startsWith('--') && raw.includes('=')) {
      const eq = raw.indexOf('=');
      flags[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else if (raw.startsWith('--') && !raw.includes('=')) {
      // --file /path/to/a.pdf
      const key = raw.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(raw);
    }
  }
  return { flags, rest };
}

/**
 * 解析 --file：兼容路径被 shell 按空格拆开的情况
 * （未加引号时：--file=/a/姬瑞 彤.pdf → ["/a/姬瑞", "彤.pdf"]）
 */
function resolveFileArg(
  fileFlag: string | undefined,
  rest: string[],
): { filePath?: string; rest: string[] } {
  if (!fileFlag) return { rest };

  if (existsSync(resolve(fileFlag))) {
    return { filePath: fileFlag, rest };
  }

  const parts = [fileFlag, ...rest];
  for (let n = parts.length; n >= 2; n -= 1) {
    const candidate = parts.slice(0, n).join(' ');
    if (existsSync(resolve(candidate))) {
      return { filePath: candidate, rest: parts.slice(n) };
    }
  }

  return { filePath: fileFlag, rest };
}

async function cmdStart() {
  loadEnvFile();
  await import('./index.js');
}

async function buildMessageFromFile(
  filePath: string | undefined,
  message: string,
): Promise<string> {
  if (!filePath) return message;
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(
      `文件不存在: ${abs}\n提示: 路径含空格时请加引号，例如 --file="/path/姬瑞 彤.pdf"`,
    );
  }
  const buffer = readFileSync(abs);
  const extracted = await extractTextFromBuffer(buffer, basename(abs));
  const maxChars = Number(process.env.ANALYSE_MAX_FILE_CHARS || 28000);
  let text = extracted.text || '';
  if (maxChars > 0 && text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n[文本已截断，原文约 ${extracted.text.length} 字]`;
  }
  const fileNote = `【用户上传文件 ${basename(abs)}】\n${text}`;
  return message ? `${message}\n\n${fileNote}` : fileNote;
}

async function cmdAnalyse(argv: string[], mode: 'oneshot' | 'react') {
  loadEnvFile();
  loadKnowledgeFromDisk();
  const parsed = takeFlags(argv);
  if (parsed.flags.help) {
    printHelp();
    return;
  }

  const resolved = resolveFileArg(
    typeof parsed.flags.file === 'string' ? parsed.flags.file : undefined,
    parsed.rest,
  );
  const filePath = resolved.filePath;
  const knowledgeId =
    typeof parsed.flags.knowledgeId === 'string'
      ? parsed.flags.knowledgeId
      : undefined;
  const requestId =
    typeof parsed.flags.requestId === 'string'
      ? parsed.flags.requestId
      : randomUUID();
  let message =
    resolved.rest.join(' ').trim() ||
    '请将以下材料分析/结构化为一份完整简历。';

  message = await buildMessageFromFile(filePath, message);
  if (!message.trim()) {
    throw new Error('请提供 --file 或 message');
  }

  const tag = mode === 'react' ? 'cli:analyse-react' : 'cli:analyse';
  console.log(
    `[${tag}] knowledgeDir=${getKnowledgeDir()} requestId=${requestId}`,
  );
  const { runAnalyse, runAnalyseReact } = await import('./graphs/analyse.js');
  const started = Date.now();
  const result =
    mode === 'react'
      ? await runAnalyseReact({ message, knowledgeId, requestId })
      : await runAnalyse({ message, knowledgeId, requestId });
  console.log(`[${tag}] OK ${Date.now() - started}ms`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdChat(argv: string[]) {
  loadEnvFile();
  loadKnowledgeFromDisk();
  const { flags, rest } = takeFlags(argv);
  if (flags.help) {
    printHelp();
    return;
  }

  const knowledgeId =
    typeof flags.knowledgeId === 'string' ? flags.knowledgeId : undefined;
  let threadId =
    typeof flags.threadId === 'string' ? flags.threadId : `chat-${Date.now()}`;
  const { runChat } = await import('./graphs/chatAgent.js');

  const oneShot = rest.join(' ').trim();
  if (oneShot) {
    const result = await runChat({ threadId, message: oneShot, knowledgeId });
    console.log(JSON.stringify(result, null, 2));
    console.log('\n--- reply ---\n' + (result.reply || ''));
    return;
  }

  console.log(`resume-agent chat · thread=${threadId}`);
  console.log('命令: /exit  /thread <id>  /help\n');
  const rl = createInterface({ input, output });

  const shutdown = () => {
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);

  while (true) {
    const line = (await rl.question(`you(${threadId})> `)).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') {
      shutdown();
      return;
    }
    if (line === '/help') {
      console.log('/exit  /thread <id>  /help\n直接输入消息与助手对话\n');
      continue;
    }
    if (line.startsWith('/thread')) {
      threadId = line.slice('/thread'.length).trim() || threadId;
      console.log(`已切换 thread=${threadId}\n`);
      continue;
    }
    try {
      const result = await runChat({ threadId, message: line, knowledgeId });
      console.log(`\nagent> ${result.reply || '(空)'}\n`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      console.error('（会话继续，输入 /exit 退出）\n');
    }
  }
}

function cmdPack() {
  const script = resolve(ROOT, 'scripts/pack.sh');
  const child = spawn('bash', [script], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'start':
      await cmdStart();
      break;
    case 'analyse':
      await cmdAnalyse(rest, 'oneshot');
      break;
    case 'analyse-react':
      await cmdAnalyse(rest, 'react');
      break;
    case 'chat':
      await cmdChat(rest);
      break;
    case 'pack':
      cmdPack();
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
