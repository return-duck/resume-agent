import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';

/** 读文件 / 读文档类工具：日志不打印正文内容 */
const CONTENT_HEAVY_TOOLS = new Set([
  'read_knowledge',
  'ingest_document',
  'summarize_project',
]);

const CONTENT_KEYS = new Set([
  'text',
  'inputText',
  'sourceText',
  'content',
  'body',
  'fileContent',
  'rawText',
  'resume',
]);

const MAX_LOG_CHARS = 2000;
const LONG_STRING_REDACT = 300;

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
};

type LogKind =
  | 'analyse.begin'
  | 'analyse.end'
  | 'chat.begin'
  | 'chat.end'
  | 'model.start'
  | 'model.input'
  | 'model.end'
  | 'model.error'
  | 'tool.start'
  | 'tool.end'
  | 'tool.error';

const KIND_STYLE: Record<
  LogKind,
  { icon: string; color: string; label: string }
> = {
  'analyse.begin': { icon: '▶', color: c.cyan, label: 'ANALYSE' },
  'analyse.end': { icon: '■', color: c.cyan, label: 'ANALYSE' },
  'chat.begin': { icon: '💬', color: c.blue, label: 'CHAT' },
  'chat.end': { icon: '■', color: c.blue, label: 'CHAT' },
  'model.start': { icon: '✦', color: c.magenta, label: 'MODEL' },
  'model.input': { icon: '↓', color: c.blue, label: 'MODEL' },
  'model.end': { icon: '✓', color: c.green, label: 'MODEL' },
  'model.error': { icon: '✖', color: c.red, label: 'MODEL' },
  'tool.start': { icon: '⚙', color: c.yellow, label: 'TOOL' },
  'tool.end': { icon: '✓', color: c.green, label: 'TOOL' },
  'tool.error': { icon: '✖', color: c.red, label: 'TOOL' },
};

function ts() {
  return new Date().toISOString();
}

function formatPayload(payload: unknown): string {
  if (payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function agentLog(kind: LogKind, detail: string, payload?: unknown) {
  const style = KIND_STYLE[kind];
  const head =
    `${style.color}${c.bold}${style.icon} [${style.label}]${c.reset} ` +
    `${c.dim}${ts()}${c.reset} ` +
    `${c.white}${kind}${c.reset} ${detail}`;
  const body = formatPayload(payload);
  if (!body) {
    if (kind.endsWith('.error')) console.error(head);
    else console.log(head);
    return;
  }
  const coloredBody = `${style.color}${body}${c.reset}`;
  if (kind.endsWith('.error')) console.error(head, '\n' + coloredBody);
  else console.log(head, '\n' + coloredBody);
}

function truncate(text: string, max = MAX_LOG_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

function redactString(value: string): string {
  return `[content omitted, ${value.length} chars]`;
}

function messagePreview(m: BaseMessage): Record<string, unknown> {
  const role = m._getType();
  const raw =
    typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content ?? '');
  const out: Record<string, unknown> = {
    role,
    content: truncate(raw, 500),
  };
  if ('name' in m && (m as { name?: string }).name) {
    out.name = (m as { name: string }).name;
  }
  if (
    'tool_calls' in m &&
    Array.isArray((m as { tool_calls?: unknown[] }).tool_calls) &&
    (m as { tool_calls: unknown[] }).tool_calls.length
  ) {
    out.tool_calls = (
      m as { tool_calls: Array<{ name?: string; args?: unknown }> }
    ).tool_calls.map((tc) => ({
      name: tc.name,
      args: sanitizeToolPayload(tc.name || '', tc.args),
    }));
  }
  return out;
}

function sanitizeValue(key: string, value: unknown, heavyTool: boolean): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (
      CONTENT_KEYS.has(key) ||
      (heavyTool && value.length > LONG_STRING_REDACT)
    ) {
      return redactString(value);
    }
    return truncate(value);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => sanitizeValue(String(i), v, heavyTool));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeValue(k, v, heavyTool);
    }
    return out;
  }
  return value;
}

export function sanitizeToolPayload(toolName: string, payload: unknown): unknown {
  const heavy = CONTENT_HEAVY_TOOLS.has(toolName);
  if (payload == null) return payload;
  if (typeof payload === 'string') {
    if (heavy || payload.length > LONG_STRING_REDACT) {
      return heavy ? redactString(payload) : truncate(payload);
    }
    return truncate(payload);
  }
  try {
    const parsed =
      typeof payload === 'object' ? payload : JSON.parse(String(payload));
    return sanitizeValue('', parsed, heavy);
  } catch {
    return heavy ? redactString(String(payload)) : truncate(String(payload));
  }
}

function llmOutputPreview(output: LLMResult): unknown {
  const gens = output.generations?.[0] ?? [];
  return gens.map((g) => {
    const msg = (g as { message?: BaseMessage }).message;
    if (msg) return messagePreview(msg);
    return { text: truncate(String(g.text ?? ''), 500) };
  });
}

function resolveToolName(tool: Serialized, runName?: string): string {
  return (
    runName ||
    (tool as { name?: string }).name ||
    (tool as { id?: string[] }).id?.slice(-1)[0] ||
    'tool'
  );
}

export class AgentTraceCallback extends BaseCallbackHandler {
  name = 'AgentTraceCallback';

  private toolNames = new Map<string, string>();

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
  ) {
    const modelName =
      (llm as { id?: string[] }).id?.slice(-1)[0] ||
      (llm as { name?: string }).name ||
      'chat_model';
    agentLog(
      'model.start',
      `id=${runId.slice(0, 8)} model=${modelName}`,
    );
    const flat = messages[0] ?? [];
    agentLog(
      'model.input',
      `id=${runId.slice(0, 8)} messages=${flat.length}`,
      flat.map(messagePreview),
    );
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    agentLog(
      'model.end',
      `id=${runId.slice(0, 8)}`,
      llmOutputPreview(output),
    );
  }

  handleLLMError(err: unknown, runId: string) {
    agentLog(
      'model.error',
      `id=${runId.slice(0, 8)}`,
      err instanceof Error ? err.message : String(err),
    );
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    const name = resolveToolName(tool, runName);
    this.toolNames.set(runId, name);
    let parsed: unknown = input;
    try {
      parsed = JSON.parse(input);
    } catch {
      // keep string
    }
    agentLog(
      'tool.start',
      `id=${runId.slice(0, 8)} name=${name}`,
      sanitizeToolPayload(name, parsed),
    );
  }

  handleToolEnd(output: unknown, runId: string) {
    const name = this.toolNames.get(runId) || 'tool';
    this.toolNames.delete(runId);
    const raw =
      typeof output === 'string'
        ? output
        : output && typeof output === 'object' && 'content' in (output as object)
          ? String((output as { content: unknown }).content)
          : JSON.stringify(output);
    agentLog(
      'tool.end',
      `id=${runId.slice(0, 8)} name=${name}`,
      sanitizeToolPayload(name, raw),
    );
  }

  handleToolError(err: unknown, runId: string) {
    const name = this.toolNames.get(runId) || 'tool';
    this.toolNames.delete(runId);
    agentLog(
      'tool.error',
      `id=${runId.slice(0, 8)} name=${name}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
