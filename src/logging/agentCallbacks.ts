import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { stdout as output } from 'node:process';
import {
  banner,
  bannerEnd,
  clearLine,
  clog,
  dumpModelTurn,
  extractReasoning,
  paint,
  c,
  type LogKind,
} from './logger.js';

/** 节点执行类型：code=纯逻辑 / llm=单次大模型 / react=ReAct(可调 tools) */
export type NodeExecKind = 'code' | 'llm' | 'react';

export type NodeToolCall = {
  name: string;
  startedAt: number;
  elapsedMs?: number;
};

export type NodeRecord = {
  name: string;
  kind: NodeExecKind;
  desc: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  llmCalls: number;
  toolCalls: NodeToolCall[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  /** API 未报 reasoning_tokens 时，用 reasoning 文本长度旁路估计 */
  reasoningChars: number;
};

const nodeAls = new AsyncLocalStorage<NodeRecord>();
let nodeRegistry: NodeRecord[] = [];

export function resetNodeRegistry() {
  nodeRegistry = [];
}

export function getNodeRecords(): NodeRecord[] {
  return [...nodeRegistry];
}

function currentNode(): NodeRecord | undefined {
  return nodeAls.getStore();
}

function findOpenNode(name: string): NodeRecord | undefined {
  for (let i = nodeRegistry.length - 1; i >= 0; i -= 1) {
    const r = nodeRegistry[i];
    if (r.name === name && r.endedAt == null) return r;
  }
  return undefined;
}

function resolveNode(
  metadata?: Record<string, unknown>,
  tags?: string[],
): NodeRecord | undefined {
  const fromAls = currentNode();
  if (fromAls) return fromAls;
  const metaName = metadata?.analyseNode;
  if (typeof metaName === 'string' && metaName) {
    return findOpenNode(metaName);
  }
  const tag = (tags || []).find((t) => t.startsWith('node:'));
  if (tag) return findOpenNode(tag.slice('node:'.length));
  return undefined;
}

function noteLlmCall(node?: NodeRecord) {
  const n = node ?? currentNode();
  if (n) n.llmCalls += 1;
}

function noteToolStart(name: string, node?: NodeRecord) {
  const n = node ?? currentNode();
  if (n) n.toolCalls.push({ name, startedAt: Date.now() });
}

function noteToolEnd(name: string, node?: NodeRecord) {
  const n = node ?? currentNode();
  if (!n) return;
  for (let i = n.toolCalls.length - 1; i >= 0; i -= 1) {
    const t = n.toolCalls[i];
    if (t.name === name && t.elapsedMs == null) {
      t.elapsedMs = Date.now() - t.startedAt;
      return;
    }
  }
}

function formatNodeLeave(rec: NodeRecord): string {
  const elapsed = (rec.endedAt ?? Date.now()) - rec.startedAt;
  const toolNames = rec.toolCalls.map((t) => t.name);
  const unique = [...new Set(toolNames)];
  const kindLabel =
    rec.kind === 'code'
      ? 'CODE'
      : rec.kind === 'llm'
        ? 'LLM'
        : 'REACT';
  return (
    `node.leave name=${rec.name} type=${kindLabel} kind=${rec.kind} ` +
    `ok=${rec.ok} elapsed=${elapsed}ms llmCalls=${rec.llmCalls} ` +
    `toolCalls=${toolNames.length} tools=[${unique.join(',') || '-'}]`
  );
}

/** 包裹图节点：统一打印类型 / 耗时 / LLM·工具统计（并行安全，ALS） */
export async function runNode<T>(
  meta: { name: string; kind: NodeExecKind; desc: string },
  fn: () => Promise<T>,
): Promise<T> {
  const rec: NodeRecord = {
    name: meta.name,
    kind: meta.kind,
    desc: meta.desc,
    startedAt: Date.now(),
    llmCalls: 0,
    toolCalls: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    reasoningChars: 0,
  };
  nodeRegistry.push(rec);

  return nodeAls.run(rec, async () => {
    const kindLabel =
      meta.kind === 'code' ? 'CODE' : meta.kind === 'llm' ? 'LLM' : 'REACT';
    setRunActivity(`[${kindLabel}] ${meta.name}`);
    clog(
      'flow',
      `node.enter name=${meta.name} type=${kindLabel} kind=${meta.kind} desc="${meta.desc}" ${runningSuffix()}`.trim(),
    );
    try {
      const out = await fn();
      rec.endedAt = Date.now();
      rec.ok = true;
      clog('flow', `${formatNodeLeave(rec)} ${runningSuffix()}`.trim());
      return out;
    } catch (err) {
      rec.endedAt = Date.now();
      rec.ok = false;
      clog('flow', `${formatNodeLeave(rec)} ${runningSuffix()}`.trim());
      throw err;
    }
  });
}

/** 打印本次运行各节点耗时汇总 */
export function printNodeSummary(title: string, wallMs?: number) {
  const list = getNodeRecords();
  banner(`节点耗时 · ${title}`);
  if (!list.length) {
    console.log(paint(c.dim, '(无节点记录)'));
    bannerEnd();
    return;
  }

  let sum = 0;
  for (const r of list) {
    const elapsed = (r.endedAt ?? Date.now()) - r.startedAt;
    sum += elapsed;
    const kindLabel =
      r.kind === 'code' ? 'CODE' : r.kind === 'llm' ? 'LLM' : 'REACT';
    const tools = [...new Set(r.toolCalls.map((t) => t.name))];
    const toolDetail =
      r.kind === 'react' || r.toolCalls.length
        ? ` tools=${r.toolCalls.length}×[${tools.join(',') || '-'}]`
        : r.kind === 'llm'
          ? ' tools=0 (单次LLM，非ReAct)'
          : '';
    console.log(
      `  • ${r.name.padEnd(20)} ${kindLabel.padEnd(5)} ${String(elapsed).padStart(7)}ms  llm=${r.llmCalls}${toolDetail}  ${r.ok === false ? 'FAIL' : 'ok'}`,
    );
    console.log(paint(c.dim, `      ${r.desc}`));
    if (r.toolCalls.length) {
      for (const t of r.toolCalls) {
        console.log(
          paint(
            c.dim,
            `      ↳ tool ${t.name}${t.elapsedMs != null ? ` ${t.elapsedMs}ms` : ''}`,
          ),
        );
      }
    }
  }
  const wall =
    wallMs != null
      ? wallMs
      : Math.max(...list.map((r) => (r.endedAt ?? Date.now()) - list[0].startedAt));
  clog(
    'flow',
    `summary nodes=${list.length} sumElapsed=${sum}ms wall≈${wall}ms${sum > wall * 1.2 ? ' (sum>wall ⇒ 存在并行)' : ''}`,
  );
  bannerEnd();
}

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
const HEARTBEAT_MS = 120;

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  reasoningChars: number;
  calls: number;
};

function emptyTokens(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    reasoningChars: 0,
    calls: 0,
  };
}

export function nowMs(): number {
  return Date.now();
}

/** 拼到日志 detail 里，如 elapsed=128ms */
export function elapsedSuffix(startedAt: number): string {
  return `elapsed=${Date.now() - startedAt}ms`;
}

export function formatTokens(u: TokenUsage): string {
  const reason =
    u.reasoningTokens || u.reasoningChars
      ? ` reasonTok:${u.reasoningTokens} reasonChars:${u.reasoningChars}`
      : '';
  return `tokens=in:${u.promptTokens} out:${u.completionTokens} total:${u.totalTokens}${reason} calls:${u.calls}`;
}

// ─── 整次运行时钟 + langGraph 风格 spinner ───

type RunClockState = {
  startedAt: number;
  label: string;
  activity: string;
  timer: ReturnType<typeof setInterval> | null;
  frame: number;
};

let runClock: RunClockState | null = null;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatRunning(startedAt: number): string {
  const sec = (Date.now() - startedAt) / 1000;
  return `${sec.toFixed(1)}s`;
}

export function setRunActivity(activity: string) {
  if (runClock) runClock.activity = activity;
}

function runningSuffix(): string {
  return runClock ? `· running=${formatRunning(runClock.startedAt)}` : '';
}

function writeHeartbeat() {
  if (!runClock) return;
  const sec = formatRunning(runClock.startedAt);
  const frame = SPINNER[runClock.frame++ % SPINNER.length];
  const label = runClock.activity || runClock.label;
  if (output.isTTY) {
    output.write(
      `\r${paint(c.cyan, frame)} ${label}… ${paint(c.dim, sec)}   `,
    );
  } else if (runClock.frame % 20 === 0) {
    // 非 TTY：约每 2.4s 打一行
    clog('run', `${label} · running=${sec}`);
  }
}

/** 开始整次任务计时（analyse / chat） */
export function beginRunClock(label: string) {
  endRunClock();
  resetNodeRegistry();
  runClock = {
    startedAt: Date.now(),
    label,
    activity: 'starting',
    timer: null,
    frame: 0,
  };
  runClock.timer = setInterval(writeHeartbeat, HEARTBEAT_MS);
  runClock.timer.unref?.();
}

export function endRunClock(): number | null {
  if (!runClock) return null;
  const ms = Date.now() - runClock.startedAt;
  if (runClock.timer) clearInterval(runClock.timer);
  clearLine();
  runClock = null;
  return ms;
}

/** 兼容旧调用：统一走 clog */
export function agentLog(
  kind: LogKind | string,
  detail: string,
  payload?: unknown,
) {
  const mapped: LogKind =
    kind === 'analyse.begin' || kind === 'analyse.end'
      ? 'analyse'
      : kind === 'chat.begin' || kind === 'chat.end'
        ? 'chat'
        : kind === 'model.start' ||
            kind === 'model.input' ||
            kind === 'model.end' ||
            kind === 'model.error'
          ? kind === 'model.error'
            ? 'error'
            : 'llm'
          : kind === 'tool.start' ||
              kind === 'tool.end' ||
              kind === 'tool.error'
            ? kind === 'tool.error'
              ? 'error'
              : 'tool'
            : kind === 'run.tick'
              ? 'run'
              : (['boot', 'flow', 'llm', 'tool', 'analyse', 'chat', 'run', 'warn', 'error'] as string[]).includes(
                    kind,
                  )
                ? (kind as LogKind)
                : 'flow';

  const msg = `${detail}${runningSuffix() ? ` ${runningSuffix()}` : ''}`;
  clog(mapped, msg);
  if (payload !== undefined) {
    try {
      const body =
        typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      if (body) console.log(paint(c.dim, body));
    } catch {
      console.log(paint(c.dim, String(payload)));
    }
  }
}

/** 节点/步骤计时 */
export function createStepTimer(
  kindOrDetail: LogKind | string,
  maybeDetail?: string,
): { done: (detail: string, payload?: unknown) => number } {
  // 兼容 createStepTimer('analyse.begin', 'step1...') 与 createStepTimer('step1...')
  const detail =
    maybeDetail !== undefined ? maybeDetail : String(kindOrDetail);
  const kind: LogKind =
    maybeDetail !== undefined
      ? kindOrDetail === 'analyse.begin' || kindOrDetail === 'analyse.end'
        ? 'flow'
        : (['boot', 'flow', 'llm', 'tool', 'analyse', 'chat', 'run', 'warn', 'error'] as string[]).includes(
              kindOrDetail,
            )
          ? (kindOrDetail as LogKind)
          : 'flow'
      : 'flow';

  const t0 = Date.now();
  setRunActivity(detail);
  clog(kind, `${detail} ${runningSuffix()}`.trim());
  return {
    done(doneDetail: string, payload?: unknown) {
      const ms = Date.now() - t0;
      clog(
        kind,
        `${doneDetail} ${elapsedSuffix(t0)} ${runningSuffix()}`.trim(),
      );
      if (payload !== undefined) {
        try {
          console.log(
            paint(
              c.dim,
              typeof payload === 'string'
                ? payload
                : JSON.stringify(payload, null, 2),
            ),
          );
        } catch {
          /* ignore */
        }
      }
      return ms;
    },
  };
}

type ParallelSpan = {
  name: string;
  startMs: number;
  endMs?: number;
};

/**
 * 记录扇出节点起止，用于判断是否真并行
 */
export class ParallelPhaseTrace {
  private spans = new Map<string, ParallelSpan>();
  private readonly expected: string[];

  constructor(nodeNames: string[]) {
    this.expected = nodeNames;
  }

  enter(name: string) {
    const now = Date.now();
    this.spans.set(name, { name, startMs: now });
    const active = this.activeNames();
    setRunActivity(`parallel ${active.join('+')}`);
    clog(
      'flow',
      `parallel.enter node=${name} activeCount=${active.length} active=[${active.join(',')}] ${runningSuffix()}`.trim(),
    );
  }

  leave(name: string, ok = true) {
    const now = Date.now();
    const span = this.spans.get(name);
    if (!span) {
      clog('warn', `parallel.leave node=${name} missing_enter`);
      return;
    }
    span.endMs = now;
    const elapsed = now - span.startMs;
    const active = this.activeNames();
    clog(
      'flow',
      `parallel.leave node=${name} ok=${ok} elapsed=${elapsed}ms activeCount=${active.length} active=[${active.join(',')}] ${runningSuffix()}`.trim(),
    );
    if (this.expected.every((n) => this.spans.get(n)?.endMs != null)) {
      this.summarize();
    }
  }

  private activeNames(): string[] {
    return [...this.spans.values()]
      .filter((s) => s.endMs == null)
      .map((s) => s.name);
  }

  summarize() {
    const list = this.expected
      .map((n) => this.spans.get(n))
      .filter((s): s is ParallelSpan & { endMs: number } => !!s && s.endMs != null);
    if (!list.length) return;

    const starts = list.map((s) => s.startMs);
    const ends = list.map((s) => s.endMs);
    const elapseds = list.map((s) => s.endMs - s.startMs);
    const startSpread = Math.max(...starts) - Math.min(...starts);
    const wall = Math.max(...ends) - Math.min(...starts);
    const sum = elapseds.reduce((a, b) => a + b, 0);
    const max = Math.max(...elapseds);
    const speedup = wall > 0 ? sum / wall : 0;
    const maxActive = this.maxObservedConcurrency(list);

    let verdict: 'PARALLEL' | 'LIKELY_PARALLEL' | 'SERIAL' | 'UNCLEAR';
    if (maxActive >= 2 && startSpread <= 200 && speedup >= 1.4) {
      verdict = 'PARALLEL';
    } else if (maxActive >= 2 && startSpread <= 500 && speedup >= 1.2) {
      verdict = 'LIKELY_PARALLEL';
    } else if (maxActive <= 1 || speedup < 1.15 || Math.abs(wall - sum) < 800) {
      verdict = 'SERIAL';
    } else {
      verdict = 'UNCLEAR';
    }

    banner(`并行判定 · ${verdict}`);
    clog(
      'flow',
      `maxActive=${maxActive} startSpread=${startSpread}ms wall=${wall}ms sum=${sum}ms max=${max}ms speedup=${speedup.toFixed(2)}x`,
    );
    console.log(
      paint(
        c.dim,
        '判读：startSpread 小且 maxActive≥2、wall≈max≪sum → 真并行；wall≈sum 或 maxActive=1 → 串行',
      ),
    );
    for (const s of list) {
      console.log(
        `  • ${s.name}: ${s.endMs - s.startMs}ms  (${new Date(s.startMs).toISOString().slice(11, 23)} → ${new Date(s.endMs).toISOString().slice(11, 23)})`,
      );
    }
    bannerEnd();
  }

  private maxObservedConcurrency(
    list: Array<ParallelSpan & { endMs: number }>,
  ): number {
    const events: Array<{ t: number; d: number }> = [];
    for (const s of list) {
      events.push({ t: s.startMs, d: 1 });
      events.push({ t: s.endMs, d: -1 });
    }
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    let cur = 0;
    let max = 0;
    for (const e of events) {
      cur += e.d;
      if (cur > max) max = cur;
    }
    return max;
  }
}

function truncate(text: string, max = MAX_LOG_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

function redactString(value: string): string {
  return `[content omitted, ${value.length} chars]`;
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

function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function pickReasoningTokens(bag: Record<string, unknown> | undefined): number {
  if (!bag) return 0;
  const direct = asNum(
    bag.reasoning_tokens ?? bag.reasoningTokens ?? bag.thinking_tokens,
  );
  if (direct) return direct;
  const details = (bag.completion_tokens_details ??
    bag.completionTokensDetails ??
    bag.output_tokens_details ??
    bag.outputTokenDetails) as Record<string, unknown> | undefined;
  if (details && typeof details === 'object') {
    return asNum(
      details.reasoning_tokens ?? details.reasoningTokens ?? details.thinking_tokens,
    );
  }
  return 0;
}

/** 从 LLMResult / usage_metadata 提取 token */
export function extractTokenUsage(output: LLMResult): Omit<
  TokenUsage,
  'calls'
> | null {
  const tu = (output.llmOutput as { tokenUsage?: Record<string, unknown> } | undefined)
    ?.tokenUsage;
  if (tu && typeof tu === 'object') {
    const promptTokens = asNum(tu.promptTokens ?? tu.prompt_tokens);
    const completionTokens = asNum(tu.completionTokens ?? tu.completion_tokens);
    const reasoningTokens = pickReasoningTokens(tu);
    const totalTokens =
      asNum(tu.totalTokens ?? tu.total_tokens) ||
      promptTokens + completionTokens;
    if (promptTokens || completionTokens || totalTokens || reasoningTokens) {
      return {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        reasoningChars: 0,
      };
    }
  }

  const gens = output.generations?.[0] ?? [];
  for (const g of gens) {
    const msg = (
      g as { message?: BaseMessage & { usage_metadata?: Record<string, unknown> } }
    ).message;
    const um = msg?.usage_metadata;
    if (!um) continue;
    const promptTokens = asNum(um.input_tokens ?? um.prompt_tokens);
    const completionTokens = asNum(um.output_tokens ?? um.completion_tokens);
    const reasoningTokens = pickReasoningTokens(um);
    const totalTokens =
      asNum(um.total_tokens) || promptTokens + completionTokens;
    if (promptTokens || completionTokens || totalTokens || reasoningTokens) {
      return {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        reasoningChars: 0,
      };
    }
  }

  for (const g of gens) {
    const msg = (
      g as {
        message?: {
          response_metadata?: {
            tokenUsage?: Record<string, unknown>;
            usage?: Record<string, unknown>;
          };
        };
      }
    ).message;
    const meta = msg?.response_metadata;
    const fromMeta = meta?.tokenUsage || meta?.usage;
    if (!fromMeta) continue;
    const promptTokens = asNum(
      fromMeta.promptTokens ?? fromMeta.prompt_tokens ?? fromMeta.input_tokens,
    );
    const completionTokens = asNum(
      fromMeta.completionTokens ??
        fromMeta.completion_tokens ??
        fromMeta.output_tokens,
    );
    const reasoningTokens = pickReasoningTokens(fromMeta);
    const totalTokens =
      asNum(fromMeta.totalTokens ?? fromMeta.total_tokens) ||
      promptTokens + completionTokens;
    if (promptTokens || completionTokens || totalTokens || reasoningTokens) {
      return {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        reasoningChars: 0,
      };
    }
  }

  return null;
}

function resolveToolName(tool: Serialized, runName?: string): string {
  return (
    runName ||
    (tool as { name?: string }).name ||
    (tool as { id?: string[] }).id?.slice(-1)[0] ||
    'tool'
  );
}

function firstMessageFromLlmResult(output: LLMResult): unknown {
  const g = output.generations?.[0]?.[0] as
    | { message?: unknown; text?: string }
    | undefined;
  return g?.message ?? g ?? { text: '' };
}

export class AgentTraceCallback extends BaseCallbackHandler {
  name = 'AgentTraceCallback';

  private toolNames = new Map<string, string>();
  private runStarted = new Map<string, number>();
  /** 避免 ChatModelStart + LLMStart 对同一 runId 双计 */
  private startedRuns = new Set<string>();
  /** 并行时 ALS 可能丢失，用 runId→node 归属 token / tool */
  private runNodes = new Map<string, NodeRecord>();
  private toolRunNodes = new Map<string, NodeRecord>();
  private tokens: TokenUsage = emptyTokens();
  private activeModels = 0;
  private peakModels = 0;
  private modelRound = 0;
  /** ChatModelStart 刚发生时，忽略嵌套 LLMStart，避免双计 */
  private lastChatStartAt = 0;

  getTokenUsage(): TokenUsage {
    return { ...this.tokens };
  }

  getPeakConcurrentModels(): number {
    return this.peakModels;
  }

  private beginModelRound(
    runId: string,
    modelName: string,
    msgCount: number,
    metadata?: Record<string, unknown>,
    tags?: string[],
  ): boolean {
    if (this.startedRuns.has(runId)) return false;
    this.startedRuns.add(runId);
    this.runStarted.set(runId, Date.now());
    this.activeModels += 1;
    this.modelRound += 1;
    if (this.activeModels > this.peakModels) {
      this.peakModels = this.activeModels;
    }
    const node = resolveNode(metadata, tags);
    if (node) this.runNodes.set(runId, node);
    noteLlmCall(node);
    setRunActivity(
      node
        ? `[${node.kind === 'react' ? 'REACT' : 'LLM'}] ${node.name} · 模型#${this.modelRound}`
        : `模型思考 #${this.modelRound}`,
    );
    clog(
      'llm',
      `start #${this.modelRound} id=${runId.slice(0, 8)} model=${modelName} node=${node?.name ?? '-'} concurrent=${this.activeModels} msgs=${msgCount} ${runningSuffix()}`.trim(),
    );
    return true;
  }

  private takeElapsedMs(runId: string): number | null {
    const t0 = this.runStarted.get(runId);
    this.runStarted.delete(runId);
    this.startedRuns.delete(runId);
    return t0 == null ? null : Date.now() - t0;
  }

  private addTokens(
    part: Omit<TokenUsage, 'calls'> | null,
    runId?: string,
  ): string {
    if (!part) return 'tokens=?';
    this.tokens.promptTokens += part.promptTokens;
    this.tokens.completionTokens += part.completionTokens;
    this.tokens.totalTokens += part.totalTokens;
    this.tokens.reasoningTokens += part.reasoningTokens;
    this.tokens.reasoningChars += part.reasoningChars;
    this.tokens.calls += 1;

    const node =
      (runId ? this.runNodes.get(runId) : undefined) ?? currentNode();
    if (node) {
      node.promptTokens += part.promptTokens;
      node.completionTokens += part.completionTokens;
      node.totalTokens += part.totalTokens;
      node.reasoningTokens += part.reasoningTokens;
      node.reasoningChars += part.reasoningChars;
    }

    const reason =
      part.reasoningTokens || part.reasoningChars
        ? ` reasonTok:${part.reasoningTokens} reasonChars:${part.reasoningChars}`
        : '';
    return `tokens=in:${part.promptTokens} out:${part.completionTokens} total:${part.totalTokens}${reason}`;
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extra?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ) {
    const modelName =
      (llm as { id?: string[] }).id?.slice(-1)[0] ||
      (llm as { name?: string }).name ||
      'chat_model';
    if (
      this.beginModelRound(
        runId,
        modelName,
        messages[0]?.length ?? 0,
        metadata,
        tags,
      )
    ) {
      this.lastChatStartAt = Date.now();
    }
  }

  /**
   * 部分调用路径只打 LLM 事件。若同 runId 已由 ChatModelStart 登记则跳过。
   * 注意：ChatOpenAI 常对同一次调用产生不同 runId 的 chat/llm 事件——此时靠
   * lastChatStartAt 短窗去重避免双计。
   */
  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extra?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ) {
    // 若刚有 ChatModelStart（同一次 chat 调用的嵌套 llm），跳过
    if (Date.now() - this.lastChatStartAt < 20) return;
    const modelName =
      (llm as { id?: string[] }).id?.slice(-1)[0] ||
      (llm as { name?: string }).name ||
      'llm';
    this.beginModelRound(runId, modelName, prompts.length, metadata, tags);
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    const usage = extractTokenUsage(output);
    const msg = firstMessageFromLlmResult(output);
    const reasoning = extractReasoning(
      msg as {
        additional_kwargs?: Record<string, unknown>;
        content?: unknown;
      },
    );
    const withReason: Omit<TokenUsage, 'calls'> | null = usage
      ? { ...usage, reasoningChars: usage.reasoningChars || reasoning.length }
      : reasoning.length
        ? {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            reasoningTokens: 0,
            reasoningChars: reasoning.length,
          }
        : null;
    const tokenPart = this.addTokens(withReason, runId);
    this.runNodes.delete(runId);
    const elapsedMs = this.takeElapsedMs(runId);
    // 仅当本 run 曾 begin 过才减 concurrent（嵌套 llm end 可能未 begin）
    if (elapsedMs != null) {
      this.activeModels = Math.max(0, this.activeModels - 1);
    }
    const concurrent = this.activeModels;
    setRunActivity(
      this.activeModels > 0
        ? `等待模型×${this.activeModels}`
        : '等待下一轮',
    );
    clog(
      'llm',
      `end #${this.modelRound} id=${runId.slice(0, 8)} elapsed=${elapsedMs ?? '?'}ms ${tokenPart} concurrent=${concurrent} ${runningSuffix()}`.trim(),
    );
    dumpModelTurn({
      round: this.modelRound,
      output: msg,
      meta: `${tokenPart}${elapsedMs != null ? ` · ${elapsedMs}ms` : ''}`,
    });
  }

  handleLLMError(err: unknown, runId: string) {
    const elapsedMs = this.takeElapsedMs(runId);
    if (elapsedMs != null) {
      this.activeModels = Math.max(0, this.activeModels - 1);
    }
    this.runNodes.delete(runId);
    setRunActivity('model error');
    clog(
      'error',
      `llm id=${runId.slice(0, 8)} elapsed=${elapsedMs ?? '?'}ms ${err instanceof Error ? err.message : String(err)} ${runningSuffix()}`.trim(),
    );
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.runStarted.set(runId, Date.now());
    const name = resolveToolName(tool, runName);
    this.toolNames.set(runId, name);
    const node = resolveNode(metadata, tags);
    if (node) this.toolRunNodes.set(runId, node);
    noteToolStart(name, node);
    setRunActivity(
      node ? `[REACT] ${node.name} · tool ${name}` : `工具 ${name}`,
    );
    let parsed: unknown = input;
    try {
      parsed = JSON.parse(input);
    } catch {
      // keep string
    }
    clog(
      'tool',
      `start id=${runId.slice(0, 8)} name=${name} node=${node?.name ?? '-'} ${runningSuffix()}`.trim(),
    );
    const sanitized = sanitizeToolPayload(name, parsed);
    if (sanitized !== undefined) {
      console.log(paint(c.dim, JSON.stringify(sanitized)));
    }
  }

  handleToolEnd(output: unknown, runId: string) {
    const name = this.toolNames.get(runId) || 'tool';
    this.toolNames.delete(runId);
    const t0 = this.runStarted.get(runId);
    this.runStarted.delete(runId);
    const elapsedMs = t0 == null ? null : Date.now() - t0;
    const node = this.toolRunNodes.get(runId) ?? currentNode();
    this.toolRunNodes.delete(runId);
    noteToolEnd(name, node);
    setRunActivity(
      node ? `[REACT] ${node.name} · tool完成` : `工具 ${name} 完成`,
    );
    // 工具结果不打正文（对齐 langGraph：不打印工具执行过程与返回）
    clog(
      'tool',
      `end id=${runId.slice(0, 8)} name=${name} node=${node?.name ?? '-'} elapsed=${elapsedMs ?? '?'}ms (result omitted) ${runningSuffix()}`.trim(),
    );
  }

  handleToolError(err: unknown, runId: string) {
    const name = this.toolNames.get(runId) || 'tool';
    this.toolRunNodes.delete(runId);
    this.toolNames.delete(runId);
    const elapsedMs = this.takeElapsedMs(runId);
    noteToolEnd(name);
    setRunActivity(`工具 ${name} 错误`);
    clog(
      'error',
      `tool id=${runId.slice(0, 8)} name=${name} elapsed=${elapsedMs ?? '?'}ms ${err instanceof Error ? err.message : String(err)} ${runningSuffix()}`.trim(),
    );
  }
}
