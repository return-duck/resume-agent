/**
 * 对比 analyse 各模式效率，并输出 token / reasoning 指标。
 *
 * 用法:
 *   npm run bench:analyse
 *   npm run bench:analyse -- --runs=3
 *   npm run bench:analyse -- --runs=3 --modes=oneshot,react,oneshot-nothink,oneshot-tools
 *   npm run bench:analyse -- --from-json=bench/xxx.json
 *
 * 对照模式:
 *   oneshot          — 单次 LLM（基线）
 *   react            — createReactAgent + tools
 *   oneshot-nothink  — 同 oneshot，enable_thinking=false
 *   oneshot-tools    — 同 oneshot 提示，但 bindTools
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadEnvFile } from '../src/loadEnv.js';
import { loadKnowledgeFromDisk } from '../src/knowledge/store.js';
import { extractTextFromBuffer } from '../src/parsers/document.js';
import {
  ANALYSE_MODES,
  runAnalyse,
  runAnalyseReact,
  type AnalyseMode,
  type AnalyseNodeMetrics,
  type AnalyseResult,
} from '../src/graphs/analyse.js';

const DEFAULT_FILE =
  '/Users/yangxiaoxu/Documents/姬瑞彤简历/姬瑞彤-15867575334.pdf';
const NODE_ORDER = [
  'extract_code',
  'refine_basicInfo',
  'refine_skills',
  'refine_projects',
  'merge',
] as const;
const REFINE_NODES = [
  'refine_basicInfo',
  'refine_skills',
  'refine_projects',
] as const;

type TokenBag = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  reasoningChars: number;
  calls: number;
};

type RunRow = {
  mode: AnalyseMode;
  runIndex: number;
  ok: boolean;
  error?: string;
  wallMs: number;
  peakConcurrentModels: number;
  tokens: TokenBag;
  nodes: AnalyseNodeMetrics[];
  refineStartSpreadMs: number;
  refineWallMs: number;
  refineSumMs: number;
  refineMaxActive: number;
  criticalPath: Array<{ name: string; elapsedMs: number }>;
  criticalPathMs: number;
  longestNode: { name: string; elapsedMs: number };
  toolStats: Array<{ node: string; tool: string; elapsedMs: number }>;
  toolTotalMs: number;
  toolCount: number;
};

const MODE_TITLE: Record<AnalyseMode, string> = {
  oneshot: 'analyse (oneshot)',
  react: 'analyse-react',
  'oneshot-nothink': 'analyse (oneshot-nothink)',
  'oneshot-tools': 'analyse (oneshot-tools)',
};

function emptyTokens(): TokenBag {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    reasoningChars: 0,
    calls: 0,
  };
}

function parseArgs(argv: string[]) {
  let runs = 20;
  let file = DEFAULT_FILE;
  let fromJson: string | undefined;
  // 默认不含 oneshot-nothink：当前 qwen3.*-preview 网关常强制 enable_thinking=true
  let modes: AnalyseMode[] = ['oneshot', 'react', 'oneshot-tools'];
  for (const raw of argv) {
    if (raw.startsWith('--runs=')) runs = Math.max(1, Number(raw.slice(7)) || 20);
    else if (raw.startsWith('--file=')) file = raw.slice(7);
    else if (raw.startsWith('--from-json=')) fromJson = raw.slice('--from-json='.length);
    else if (raw.startsWith('--modes=')) {
      const wanted = raw
        .slice('--modes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as AnalyseMode[];
      const ok = wanted.filter((m) => (ANALYSE_MODES as string[]).includes(m));
      if (ok.length) modes = ok;
    } else if (raw === '--help' || raw === '-h') {
      console.log(
        `Usage: npm run bench:analyse -- [--runs=20] [--file=path.pdf]\n` +
          `         [--modes=oneshot,react,oneshot-tools,oneshot-nothink]\n` +
          `       npm run bench:analyse -- --from-json=bench/xxx.json\n` +
          `注意: oneshot-nothink 在强制 thinking 的预览模型上会 400失败`,
      );
      process.exit(0);
    }
  }
  return { runs, file, fromJson, modes };
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p95(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1);
  return s[i];
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtN(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '-';
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

function maxConcurrency(
  spans: Array<{ start: number; end: number }>,
): number {
  const events: Array<{ t: number; d: number }> = [];
  for (const s of spans) {
    events.push({ t: s.start, d: 1 });
    events.push({ t: s.end, d: -1 });
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

function sumNodeTokens(nodes: AnalyseNodeMetrics[]): TokenBag {
  const t = emptyTokens();
  for (const n of nodes) {
    t.promptTokens += n.promptTokens || 0;
    t.completionTokens += n.completionTokens || 0;
    t.totalTokens += n.totalTokens || 0;
    t.reasoningTokens += n.reasoningTokens || 0;
    t.reasoningChars += n.reasoningChars || 0;
    t.calls += n.llmCalls || 0;
  }
  return t;
}

function analyzeRun(
  mode: AnalyseMode,
  runIndex: number,
  result: AnalyseResult,
): RunRow {
  const nodes = result.metrics.nodes;
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const refines = REFINE_NODES.map((n) => byName.get(n)).filter(
    (n): n is AnalyseNodeMetrics => !!n,
  );

  const refineStarts = refines.map((n) => n.startedAt);
  const refineEnds = refines.map((n) => n.endedAt);
  const refineStartSpreadMs = refineStarts.length
    ? Math.max(...refineStarts) - Math.min(...refineStarts)
    : 0;
  const refineWallMs = refineStarts.length
    ? Math.max(...refineEnds) - Math.min(...refineStarts)
    : 0;
  const refineSumMs = refines.reduce((s, n) => s + n.elapsedMs, 0);
  const refineMaxActive = maxConcurrency(
    refines.map((n) => ({ start: n.startedAt, end: n.endedAt })),
  );

  const extract = byName.get('extract_code');
  const merge = byName.get('merge');
  const maxRefine = refines.reduce(
    (a, b) => (a.elapsedMs >= b.elapsedMs ? a : b),
    refines[0],
  );

  const criticalPath = [
    extract && { name: extract.name, elapsedMs: extract.elapsedMs },
    maxRefine && { name: maxRefine.name, elapsedMs: maxRefine.elapsedMs },
    merge && { name: merge.name, elapsedMs: merge.elapsedMs },
  ].filter(Boolean) as Array<{ name: string; elapsedMs: number }>;

  const criticalPathMs = criticalPath.reduce((s, c) => s + c.elapsedMs, 0);

  const longestNode = nodes.reduce(
    (a, b) => (a.elapsedMs >= b.elapsedMs ? a : b),
    nodes[0] ?? {
      name: '-',
      elapsedMs: 0,
      kind: 'code' as const,
      desc: '',
      startedAt: 0,
      endedAt: 0,
      ok: true,
      llmCalls: 0,
      toolCalls: [],
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      reasoningChars: 0,
    },
  );

  const toolStats = nodes.flatMap((n) =>
    n.toolCalls.map((t) => ({
      node: n.name,
      tool: t.name,
      elapsedMs: t.elapsedMs,
    })),
  );

  const tokens = result.metrics.tokens
    ? { ...emptyTokens(), ...result.metrics.tokens }
    : sumNodeTokens(nodes);

  return {
    mode,
    runIndex,
    ok: true,
    wallMs: result.metrics.wallMs,
    peakConcurrentModels: result.metrics.peakConcurrentModels,
    tokens,
    nodes,
    refineStartSpreadMs,
    refineWallMs,
    refineSumMs,
    refineMaxActive,
    criticalPath,
    criticalPathMs,
    longestNode: { name: longestNode.name, elapsedMs: longestNode.elapsedMs },
    toolStats,
    toolTotalMs: toolStats.reduce((s, t) => s + t.elapsedMs, 0),
    toolCount: toolStats.length,
  };
}

async function loadMessage(filePath: string): Promise<string> {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const buf = readFileSync(abs);
  const extracted = await extractTextFromBuffer(buf, basename(abs));
  const maxChars = Number(process.env.ANALYSE_MAX_FILE_CHARS || 28000);
  let text = extracted.text || '';
  if (maxChars > 0 && text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n[文本已截断，原文约 ${extracted.text.length} 字]`;
  }
  return `请将以下材料分析/结构化为一份完整简历。\n\n【用户上传文件 ${basename(abs)}】\n${text}`;
}

async function runOnce(
  mode: AnalyseMode,
  runIndex: number,
  message: string,
): Promise<RunRow> {
  const requestId = `bench-${mode}-${runIndex}-${Date.now()}`;
  try {
    const result =
      mode === 'react'
        ? await runAnalyseReact({ message, requestId })
        : await runAnalyse({ message, requestId, mode });
    return analyzeRun(mode, runIndex, result);
  } catch (err) {
    return {
      mode,
      runIndex,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      wallMs: 0,
      peakConcurrentModels: 0,
      tokens: emptyTokens(),
      nodes: [],
      refineStartSpreadMs: 0,
      refineWallMs: 0,
      refineSumMs: 0,
      refineMaxActive: 0,
      criticalPath: [],
      criticalPathMs: 0,
      longestNode: { name: '-', elapsedMs: 0 },
      toolStats: [],
      toolTotalMs: 0,
      toolCount: 0,
    };
  }
}

function avgTokens(rows: RunRow[]): TokenBag {
  const ok = rows.filter((r) => r.ok);
  if (!ok.length) return emptyTokens();
  return {
    promptTokens: avg(ok.map((r) => r.tokens.promptTokens)),
    completionTokens: avg(ok.map((r) => r.tokens.completionTokens)),
    totalTokens: avg(ok.map((r) => r.tokens.totalTokens)),
    reasoningTokens: avg(ok.map((r) => r.tokens.reasoningTokens)),
    reasoningChars: avg(ok.map((r) => r.tokens.reasoningChars)),
    calls: avg(ok.map((r) => r.tokens.calls)),
  };
}

function nodeAvgTable(rows: RunRow[]): string {
  const ok = rows.filter((r) => r.ok);
  const lines = [
    '| 节点 | 类型 | 平均耗时 | 中位 | P95 | llmCalls | tools | in | out | reasonTok | reasonChars |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const name of NODE_ORDER) {
    const samples = ok
      .map((r) => r.nodes.find((n) => n.name === name))
      .filter((n): n is AnalyseNodeMetrics => !!n);
    if (!samples.length) continue;
    const el = samples.map((s) => s.elapsedMs);
    lines.push(
      `| ${name} | ${samples[0].kind} | ${fmtMs(avg(el))} | ${fmtMs(median(el))} | ${fmtMs(p95(el))} | ${avg(samples.map((s) => s.llmCalls)).toFixed(2)} | ${avg(samples.map((s) => s.toolCalls.length)).toFixed(2)} | ${fmtN(avg(samples.map((s) => s.promptTokens || 0)))} | ${fmtN(avg(samples.map((s) => s.completionTokens || 0)))} | ${fmtN(avg(samples.map((s) => s.reasoningTokens || 0)))} | ${fmtN(avg(samples.map((s) => s.reasoningChars || 0)))} |`,
    );
  }
  return lines.join('\n');
}

function toolAggTable(rows: RunRow[]): string {
  const ok = rows.filter((r) => r.ok);
  const map = new Map<string, number[]>();
  for (const r of ok) {
    for (const t of r.toolStats) {
      const key = `${t.node} / ${t.tool}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t.elapsedMs);
    }
  }
  if (!map.size) return '_无工具调用_';
  const lines = [
    '| 节点 / 工具 | 调用次数(总) | 平均耗时 | 中位 | P95 |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const [key, vals] of [...map.entries()].sort()) {
    lines.push(
      `| ${key} | ${vals.length} | ${fmtMs(avg(vals))} | ${fmtMs(median(vals))} | ${fmtMs(p95(vals))} |`,
    );
  }
  return lines.join('\n');
}

function perRunTable(rows: RunRow[]): string {
  const lines = [
    '| # | 成功 | wall | 最长节点 | refine wall | tools | in | out | reasonTok | reasonChars | llmCalls |',
    '|---:|:---:|---:|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.runIndex} | ${r.ok ? '✓' : '✗'} | ${fmtMs(r.wallMs)} | ${r.longestNode.name} ${fmtMs(r.longestNode.elapsedMs)} | ${fmtMs(r.refineWallMs)} | ${r.toolCount} | ${fmtN(r.tokens.promptTokens)} | ${fmtN(r.tokens.completionTokens)} | ${fmtN(r.tokens.reasoningTokens)} | ${fmtN(r.tokens.reasoningChars)} | ${fmtN(r.tokens.calls)} |`,
    );
    if (!r.ok && r.error) {
      lines.push(`| | | | | | | | | | | 错误: ${r.error.replace(/\|/g, '/')} |`);
    }
  }
  return lines.join('\n');
}

function mermaidFlow(mode: AnalyseMode, rows: RunRow[]): string {
  const ok = rows.filter((r) => r.ok);
  const el = (name: string) => {
    const vals = ok
      .map((r) => r.nodes.find((n) => n.name === name)?.elapsedMs)
      .filter((x): x is number => typeof x === 'number');
    return vals.length ? fmtMs(avg(vals)) : '-';
  };
  const kind = (name: string) => {
    for (const r of ok) {
      const n = r.nodes.find((x) => x.name === name);
      if (n) return n.kind.toUpperCase();
    }
    return '?';
  };
  return `\`\`\`mermaid
flowchart TB
  subgraph ${mode.replace(/-/g, '_')}["${MODE_TITLE[mode]} · 平均耗时"]
    A["extract_code\\n${kind('extract_code')} · ${el('extract_code')}"]
    B1["refine_basicInfo\\n${kind('refine_basicInfo')} · ${el('refine_basicInfo')}"]
    B2["refine_skills\\n${kind('refine_skills')} · ${el('refine_skills')}"]
    B3["refine_projects\\n${kind('refine_projects')} · ${el('refine_projects')}"]
    C["merge\\n${kind('merge')} · ${el('merge')}"]
    A --> B1
    A --> B2
    A --> B3
    B1 --> C
    B2 --> C
    B3 --> C
  end
\`\`\``;
}

function summarizeMode(mode: AnalyseMode, rows: RunRow[]): string {
  const ok = rows.filter((r) => r.ok);
  const walls = ok.map((r) => r.wallMs);
  const crits = ok.map((r) => r.criticalPathMs);
  const tok = avgTokens(ok);
  const longestVotes = new Map<string, number>();
  for (const r of ok) {
    longestVotes.set(
      r.longestNode.name,
      (longestVotes.get(r.longestNode.name) || 0) + 1,
    );
  }
  const longestTop = [...longestVotes.entries()].sort((a, b) => b[1] - a[1])[0];

  return `### ${MODE_TITLE[mode]}

- 成功/总数: **${ok.length}/${rows.length}**
- 全流程 wall: 平均 **${fmtMs(avg(walls))}** · 中位 **${fmtMs(median(walls))}** · P95 **${fmtMs(p95(walls))}**
- 关键路径: 平均 **${fmtMs(avg(crits))}** · 中位 **${fmtMs(median(crits))}**
- refine: refineWall 平均 **${fmtMs(avg(ok.map((r) => r.refineWallMs)))}** · refineSum 平均 **${fmtMs(avg(ok.map((r) => r.refineSumMs)))}**
- tokens 平均: in **${fmtN(tok.promptTokens)}** · out **${fmtN(tok.completionTokens)}** · reasonTok **${fmtN(tok.reasoningTokens)}** · reasonChars **${fmtN(tok.reasoningChars)}** · llmCalls **${tok.calls.toFixed(2)}**
- 最长节点出现最多: **${longestTop ? `${longestTop[0]} (${longestTop[1]} 次)` : '-'}**
- 工具: 平均每次 **${avg(ok.map((r) => r.toolCount)).toFixed(2)}** 次 · 耗时合计平均 **${fmtMs(avg(ok.map((r) => r.toolTotalMs)))}**

#### 节点耗时 / token

${nodeAvgTable(rows)}

#### 工具调用耗时

${toolAggTable(rows)}

#### 调用流程图（平均耗时）

${mermaidFlow(mode, rows)}

#### 每次明细

${perRunTable(rows)}
`;
}

function comparisonSection(byMode: Map<AnalyseMode, RunRow[]>): string {
  const modes = [...byMode.keys()];
  const baseline = byMode.get('oneshot')?.filter((r) => r.ok) ?? [];
  const baseWall = avg(baseline.map((x) => x.wallMs));
  const baseTok = avgTokens(baseline);

  const header = ['指标', ...modes.map((m) => MODE_TITLE[m])].join(' | ');
  const sep = ['---', ...modes.map(() => '---:')].join('|');

  const cell = (mode: AnalyseMode, fn: (ok: RunRow[]) => string) => {
    const ok = (byMode.get(mode) || []).filter((r) => r.ok);
    return ok.length ? fn(ok) : '-';
  };

  const rows: string[] = [
    `| ${header} |`,
    `|${sep}|`,
    `| 平均 wall | ${modes.map((m) => cell(m, (ok) => fmtMs(avg(ok.map((x) => x.wallMs))))).join(' | ')} |`,
    `| 中位 wall | ${modes.map((m) => cell(m, (ok) => fmtMs(median(ok.map((x) => x.wallMs))))).join(' | ')} |`,
    `| P95 wall | ${modes.map((m) => cell(m, (ok) => fmtMs(p95(ok.map((x) => x.wallMs))))).join(' | ')} |`,
    `| vs oneshot wall | ${modes
      .map((m) =>
        cell(m, (ok) => {
          const w = avg(ok.map((x) => x.wallMs));
          if (!baseWall) return '-';
          return `${(w / baseWall).toFixed(2)}x`;
        }),
      )
      .join(' | ')} |`,
    `| 平均 prompt tokens | ${modes.map((m) => cell(m, (ok) => fmtN(avgTokens(ok).promptTokens))).join(' | ')} |`,
    `| 平均 completion tokens | ${modes.map((m) => cell(m, (ok) => fmtN(avgTokens(ok).completionTokens))).join(' | ')} |`,
    `| 平均 reasoning tokens | ${modes.map((m) => cell(m, (ok) => fmtN(avgTokens(ok).reasoningTokens))).join(' | ')} |`,
    `| 平均 reasoning chars | ${modes.map((m) => cell(m, (ok) => fmtN(avgTokens(ok).reasoningChars))).join(' | ')} |`,
    `| 平均 llmCalls | ${modes.map((m) => cell(m, (ok) => avgTokens(ok).calls.toFixed(2))).join(' | ')} |`,
    `| 平均 toolCalls | ${modes.map((m) => cell(m, (ok) => avg(ok.map((x) => x.toolCount)).toFixed(2))).join(' | ')} |`,
  ];

  // 节点耗时对比（相对 oneshot）
  const nodeLines = [
    '',
    '### 各节点耗时对比（平均）',
    '',
    `| 节点 | ${modes.map((m) => MODE_TITLE[m]).join(' | ')} |`,
    `|---|${modes.map(() => '---:').join('|')}|`,
  ];
  for (const name of NODE_ORDER) {
    nodeLines.push(
      `| ${name} | ${modes
        .map((m) =>
          cell(m, (ok) => {
            const vals = ok
              .map((r) => r.nodes.find((n) => n.name === name)?.elapsedMs)
              .filter((x): x is number => typeof x === 'number');
            return vals.length ? fmtMs(avg(vals)) : '-';
          }),
        )
        .join(' | ')} |`,
    );
  }

  const reactOk = (byMode.get('react') || []).filter((r) => r.ok);
  const nothinkOk = (byMode.get('oneshot-nothink') || []).filter((r) => r.ok);
  const toolsOk = (byMode.get('oneshot-tools') || []).filter((r) => r.ok);
  const reactWall = avg(reactOk.map((x) => x.wallMs));
  const nothinkWall = avg(nothinkOk.map((x) => x.wallMs));
  const toolsWall = avg(toolsOk.map((x) => x.wallMs));
  const reactTok = avgTokens(reactOk);
  const nothinkTok = avgTokens(nothinkOk);
  const toolsTok = avgTokens(toolsOk);

  const findings: string[] = ['', '### 假设验证', ''];
  if (baseline.length && reactOk.length) {
    findings.push(
      `- **react vs oneshot**: wall ${(reactWall / (baseWall || 1)).toFixed(2)}x；completion ${(reactTok.completionTokens / (baseTok.completionTokens || 1)).toFixed(2)}x；reasonChars ${(reactTok.reasoningChars / (baseTok.reasoningChars || 1) || 0).toFixed(2)}x。completion 更短通常对应更快的 wall。`,
    );
  }
  const nothinkRows = byMode.get('oneshot-nothink') || [];
  const nothinkFail = nothinkRows.filter((r) => !r.ok);
  if (nothinkFail.length && !nothinkOk.length) {
    findings.push(
      `- **oneshot-nothink**: 全部失败（${nothinkFail[0]?.error || 'unknown'}）。当前模型/网关可能强制 \`enable_thinking=true\`，无法用关 thinking 做对照。`,
    );
  } else if (baseline.length && nothinkOk.length) {
    const ratioBase = nothinkWall / (baseWall || 1);
    const ratioReact = reactOk.length ? nothinkWall / (reactWall || 1) : NaN;
    const bogus = avg(nothinkOk.map((r) => r.tokens.calls)) < 0.5 || nothinkWall < 2000;
    findings.push(
      `- **oneshot-nothink**: wall ${ratioBase.toFixed(2)}x oneshot` +
        (reactOk.length ? `、${ratioReact.toFixed(2)}x react` : '') +
        `；reasonChars ${fmtN(nothinkTok.reasoningChars)}` +
        (bogus
          ? '。⚠ 结果异常（几乎无有效 LLM 调用），请检查是否被网关拒绝后误计成功。'
          : ratioReact < 1.25
            ? '。接近 react ⇒ **thinking 是主因**。'
            : '。仍明显慢于 react ⇒ thinking 不是唯一主因。'),
    );
  }
  if (baseline.length && toolsOk.length) {
    const ratioBase = toolsWall / (baseWall || 1);
    const ratioReact = reactOk.length ? toolsWall / (reactWall || 1) : NaN;
    findings.push(
      `- **oneshot-tools**: wall ${ratioBase.toFixed(2)}x oneshot` +
        (reactOk.length ? `、${ratioReact.toFixed(2)}x react` : '') +
        `；avg tools ${avg(toolsOk.map((x) => x.toolCount)).toFixed(2)}；completion ${fmtN(toolsTok.completionTokens)}` +
        (ratioBase <= 0.85 && ratioReact <= 1.25
          ? '。接近 react ⇒ **bindTools / tool schema 是主因之一**。'
          : ratioBase <= 0.85
            ? '。明显快于 oneshot、但仍慢于 react ⇒ **绑 tools 能解释部分差距**，ReAct 编排还有额外收益。'
            : '。仍接近 oneshot ⇒ 单纯绑 tools 不足以解释差距。'),
    );
  }
  findings.push(
    `- reasonTok 来自 API usage；若为 0 则以 reasonChars（reasoning_content）作旁路。当前网关常不回传 reasoning 字段，此时用 **completion tokens** 作生成量代理。`,
  );

  return [
    '## 效率 / Token 对比结论',
    '',
    ...rows,
    ...nodeLines,
    ...findings,
  ].join('\n');
}

function writeReport(opts: {
  file: string;
  runs: number;
  modes: AnalyseMode[];
  byMode: Map<AnalyseMode, RunRow[]>;
  outMdPath?: string;
  outJsonPath?: string;
  writeJson?: boolean;
}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(process.cwd(), 'bench');
  mkdirSync(outDir, { recursive: true });
  const mdPath = opts.outMdPath || resolve(outDir, `analyse-compare-${stamp}.md`);
  const jsonPath =
    opts.outJsonPath || resolve(outDir, `analyse-compare-${stamp}.json`);

  const detail = opts.modes
    .map((m) => `## ${MODE_TITLE[m]} 明细\n\n${summarizeMode(m, opts.byMode.get(m) || [])}`)
    .join('\n');

  const md = `# analyse 多模式效率 / Token 对比

- 生成时间: ${new Date().toISOString()}
- 文件: \`${opts.file}\`
- 每模式次数: **${opts.runs}**
- 模式: ${opts.modes.map((m) => `\`${m}\``).join(', ')}
- 环境: LLM_MODEL=\`${process.env.LLM_MODEL || process.env.OPENAI_MODEL || ''}\` BASE=\`${process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || ''}\`

## 图结构（各模式相同）

\`\`\`mermaid
flowchart LR
  A[extract_code<br/>CODE] --> B1[refine_basicInfo]
  A --> B2[refine_skills]
  A --> B3[refine_projects]
  B1 --> C[merge<br/>CODE]
  B2 --> C
  B3 --> C
\`\`\`

- oneshot: 单次 LLM
- react: createReactAgent + tools
- oneshot-nothink: 同 oneshot，\`enable_thinking=false\`
- oneshot-tools: 同 oneshot 提示 + \`bindTools\`（对照 tool schema / 短工具环）

${comparisonSection(opts.byMode)}

${detail}
`;

  writeFileSync(mdPath, md, 'utf8');
  if (opts.writeJson !== false) {
    const payload: Record<string, unknown> = {
      file: opts.file,
      runs: opts.runs,
      modes: opts.modes,
    };
    for (const m of opts.modes) {
      payload[`${m}Rows`] = opts.byMode.get(m) || [];
    }
    // 兼容旧字段
    payload.oneshotRows = opts.byMode.get('oneshot') || [];
    payload.reactRows = opts.byMode.get('react') || [];
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  }
  console.log(`\n[bench] Markdown: ${mdPath}`);
  if (opts.writeJson !== false) console.log(`[bench] JSON:     ${jsonPath}`);
  return { mdPath, jsonPath };
}

async function main() {
  loadEnvFile();
  loadKnowledgeFromDisk();
  const { runs, file, fromJson, modes } = parseArgs(process.argv.slice(2));

  if (fromJson) {
    const abs = resolve(fromJson);
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    const modeList = (Array.isArray(raw.modes)
      ? (raw.modes as AnalyseMode[])
      : ['oneshot', 'react']) as AnalyseMode[];
    const byMode = new Map<AnalyseMode, RunRow[]>();
    for (const m of modeList) {
      const key = `${m}Rows`;
      byMode.set(m, (raw[key] as RunRow[]) || []);
    }
    if (!byMode.has('oneshot') && raw.oneshotRows) {
      byMode.set('oneshot', raw.oneshotRows as RunRow[]);
    }
    if (!byMode.has('react') && raw.reactRows) {
      byMode.set('react', raw.reactRows as RunRow[]);
    }
    const mdPath = abs.replace(/\.json$/i, '.md');
    writeReport({
      file: String(raw.file || ''),
      runs: Number(raw.runs || 0),
      modes: [...byMode.keys()],
      byMode,
      outMdPath: mdPath,
      writeJson: false,
    });
    return;
  }

  console.log(`[bench] file=${file}`);
  console.log(
    `[bench] modes=${modes.join(',')} runs each=${runs} (total ${runs * modes.length})`,
  );
  const message = await loadMessage(file);
  console.log(`[bench] messageChars=${message.length}`);

  const byMode = new Map<AnalyseMode, RunRow[]>();
  for (const mode of modes) {
    const rows: RunRow[] = [];
    for (let i = 1; i <= runs; i += 1) {
      console.log(`\n[bench] ===== ${MODE_TITLE[mode]} #${i}/${runs} =====`);
      const row = await runOnce(mode, i, message);
      rows.push(row);
      console.log(
        `[bench] ${mode}#${i} ok=${row.ok} wall=${fmtMs(row.wallMs)} longest=${row.longestNode.name}:${fmtMs(row.longestNode.elapsedMs)} tools=${row.toolCount} tokens=in:${fmtN(row.tokens.promptTokens)}/out:${fmtN(row.tokens.completionTokens)} reasonChars:${fmtN(row.tokens.reasoningChars)}`,
      );
    }
    byMode.set(mode, rows);
  }

  writeReport({ file, runs, modes, byMode });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
