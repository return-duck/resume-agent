/**
 * CLI 彩色日志（对齐 langGraph/src/cli/logger.ts）
 * 格式: HH:mm:ss.SSS 🔀 [flow] message
 */
import { stdout as output, stderr } from 'node:process';

const useColor = Boolean(output.isTTY) && !process.env.NO_COLOR;

export const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export function paint(code: string, text: string) {
  return useColor ? `${code}${text}${c.reset}` : text;
}

export type LogKind =
  | 'boot'
  | 'flow'
  | 'llm'
  | 'tool'
  | 'analyse'
  | 'chat'
  | 'run'
  | 'warn'
  | 'error';

const STYLE: Record<LogKind, { icon: string; color: string; label: string }> = {
  boot: { icon: '🚀', color: c.cyan, label: 'boot' },
  flow: { icon: '🔀', color: c.magenta, label: 'flow' },
  llm: { icon: '🧠', color: c.yellow, label: 'llm' },
  tool: { icon: '🔧', color: c.green, label: 'tool' },
  analyse: { icon: '📄', color: c.cyan, label: 'analyse' },
  chat: { icon: '💬', color: c.blue, label: 'chat' },
  run: { icon: '⏱', color: c.gray, label: 'run' },
  warn: { icon: '⚠️', color: c.yellow, label: 'warn' },
  error: { icon: '❌', color: c.red, label: 'error' },
};

function shortTs() {
  return new Date().toISOString().slice(11, 23);
}

export function clearLine() {
  if (output.isTTY) output.write('\r\x1b[K');
  if (stderr.isTTY) stderr.write('\r\x1b[2K');
}

export function clog(kind: LogKind, message: string) {
  clearLine();
  const s = STYLE[kind];
  const tag = paint(s.color, `[${s.label}]`);
  const line = `${paint(c.gray, shortTs())} ${s.icon} ${tag} ${message}`;
  if (kind === 'error') console.error(line);
  else console.log(line);
}

export function banner(title: string) {
  clearLine();
  const line = '─'.repeat(Math.max(8, 48 - title.length));
  console.log(paint(c.bold + c.cyan, `\n╭─ ${title} ${line}╮`));
}

export function bannerEnd() {
  console.log(paint(c.cyan, `╰${'─'.repeat(48)}╯\n`));
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        if (part && typeof part === 'object' && 'type' in part) {
          const p = part as { type: string; thinking?: string; text?: string };
          if (p.type === 'thinking') return String(p.thinking ?? '');
          if (p.type === 'text') return String(p.text ?? '');
          return JSON.stringify(part);
        }
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  if (typeof content === 'object') return JSON.stringify(content, null, 2);
  return String(content);
}

/** 从模型消息中抽出思考链文本（供日志与 token 旁路统计） */
export function extractReasoning(out: {
  additional_kwargs?: Record<string, unknown>;
  content?: unknown;
} | null | undefined): string {
  if (!out) return '';
  const ak = out.additional_kwargs ?? {};
  for (const key of ['reasoning_content', 'reasoning', 'thinking'] as const) {
    const v = ak[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (Array.isArray(out.content)) {
    const thinking = out.content
      .filter(
        (p) =>
          p &&
          typeof p === 'object' &&
          'type' in p &&
          (p as { type: string }).type === 'thinking',
      )
      .map((p) => String((p as { thinking?: string }).thinking ?? ''))
      .join('\n')
      .trim();
    if (thinking) return thinking;
  }
  return '';
}

function truncate(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

/** 打印本轮模型输出：思考 + 可见回复 + 拟调用工具（对齐 langGraph） */
export function dumpModelTurn(opts: {
  round: number;
  nodeHint?: string;
  output: unknown;
  meta?: string;
}) {
  const { round, nodeHint, output, meta } = opts;
  const out = output as {
    content?: unknown;
    tool_calls?: Array<{ name?: string; args?: unknown; id?: string }>;
    additional_kwargs?: Record<string, unknown>;
  };

  const reasoning = extractReasoning(out);
  const reply = extractText(out?.content).trim();
  const toolCalls = out?.tool_calls ?? [];

  banner(
    `模型输出 #${round}${nodeHint ? ` @${nodeHint}` : ''}${meta ? ` · ${meta}` : ''}`,
  );

  console.log(paint(c.bold + c.magenta, '\n🧠 ▶ 思考过程 (reasoning)\n'));
  if (reasoning) {
    console.log(truncate(reasoning));
  } else {
    console.log(paint(c.dim, '(本轮无 reasoning_content)'));
  }

  console.log(paint(c.bold + c.yellow, '\n💬 ▶ 可见回复\n'));
  if (reply) {
    console.log(truncate(reply));
  } else {
    console.log(paint(c.dim, '(无文本，可能直接调工具)'));
  }

  console.log(paint(c.bold + c.green, '\n🔧 ▶ 拟调用工具\n'));
  if (!toolCalls.length) {
    console.log(paint(c.dim, '(无 tool_calls)'));
  } else {
    for (const tc of toolCalls) {
      const args =
        tc.args && typeof tc.args === 'object'
          ? JSON.stringify(tc.args)
          : String(tc.args ?? '');
      console.log(`  • ${tc.name ?? '?'}(${truncate(args, 400)})`);
    }
  }

  bannerEnd();
}
