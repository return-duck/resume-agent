import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { randomUUID } from 'node:crypto';
import { createChatModel, extractJsonObject } from '../llm.js';
import {
  AgentTraceCallback,
  beginRunClock,
  elapsedSuffix,
  endRunClock,
  formatTokens,
  getNodeRecords,
  nowMs,
  ParallelPhaseTrace,
  printNodeSummary,
  runNode,
  type NodeExecKind,
  type NodeRecord,
  type TokenUsage,
} from '../logging/agentCallbacks.js';
import { clog } from '../logging/logger.js';
import { getKnowledge } from '../knowledge/store.js';
import {
  extractResumeDraft,
  sectionText,
} from '../parsers/extractResumeDraft.js';
import {
  BasicInfoSchema,
  CompanySchema,
  ProjectSchema,
  ResumeSchema,
  SkillDtoSchema,
  type Resume,
} from '../schemas/resume.js';
import { createAnalyseReactTools } from '../tools/analyseReactTools.js';
import { z } from 'zod';

/**
 * oneshot — 单次 LLM
 * react — createReactAgent + tools
 * oneshot-nothink — 同 oneshot，但 enable_thinking=false
 * oneshot-tools — 同 oneshot 提示，但 bindTools（验证工具 schema 是否改变生成行为）
 */
export type AnalyseMode =
  | 'oneshot'
  | 'react'
  | 'oneshot-nothink'
  | 'oneshot-tools';

export const ANALYSE_MODES: AnalyseMode[] = [
  'oneshot',
  'react',
  'oneshot-nothink',
  'oneshot-tools',
];

export interface AnalyseInput {
  message: string;
  knowledgeId?: string;
  resume?: Resume;
  requestId?: string;
  mode?: AnalyseMode;
}

export type AnalyseNodeMetrics = {
  name: string;
  kind: NodeExecKind;
  desc: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  ok: boolean;
  llmCalls: number;
  toolCalls: Array<{ name: string; elapsedMs: number }>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  reasoningChars: number;
};

export interface AnalyseResult {
  requestId: string;
  knowledgeId?: string;
  resume: Resume;
  mode: AnalyseMode;
  /** 结构化耗时（供压测/对比脚本使用） */
  metrics: {
    wallMs: number;
    peakConcurrentModels: number;
    tokens: TokenUsage;
    nodes: AnalyseNodeMetrics[];
  };
}

function snapshotNodeMetrics(records: NodeRecord[]): AnalyseNodeMetrics[] {
  return records.map((r) => {
    const endedAt = r.endedAt ?? Date.now();
    return {
      name: r.name,
      kind: r.kind,
      desc: r.desc,
      startedAt: r.startedAt,
      endedAt,
      elapsedMs: endedAt - r.startedAt,
      ok: r.ok !== false,
      llmCalls: r.llmCalls,
      toolCalls: r.toolCalls.map((t) => ({
        name: t.name,
        elapsedMs: t.elapsedMs ?? 0,
      })),
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      reasoningTokens: r.reasoningTokens,
      reasoningChars: r.reasoningChars,
    };
  });
}

function modeLabel(mode: AnalyseMode): string {
  switch (mode) {
    case 'react':
      return 'analyse-react';
    case 'oneshot-nothink':
      return 'analyse-oneshot-nothink';
    case 'oneshot-tools':
      return 'analyse-oneshot-tools';
    default:
      return 'analyse';
  }
}

function isReactMode(mode: AnalyseMode): boolean {
  return mode === 'react';
}

function enableThinkingFor(mode: AnalyseMode): boolean | undefined {
  if (mode === 'oneshot-nothink') return false;
  return undefined;
}

function bindToolsFor(mode: AnalyseMode): boolean {
  return mode === 'oneshot-tools';
}

/** 配置类错误（如网关禁止关 thinking）不应吞掉 fallback，否则 bench 会假成功 */
function isFatalLlmConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /enable_thinking|restricted to True|invalid.*thinking|model_not_found/i.test(
    msg,
  );
}

type ModulePatch = {
  module: 'basicInfo' | 'skills' | 'projects';
  name?: string;
  title?: string;
  basicInfo?: Resume['basicInfo'];
  skills?: Resume['skills'];
  projects?: Resume['projects'];
  companies?: Resume['companies'];
};

const AnalyseState = Annotation.Root({
  requestId: Annotation<string>,
  knowledgeId: Annotation<string | undefined>,
  sourceText: Annotation<string>,
  message: Annotation<string>,
  draft: Annotation<Resume>,
  sectionBlob: Annotation<Record<string, string[]>>,
  /** 并行节点各自追加 patch */
  patches: Annotation<ModulePatch[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  resume: Annotation<Resume | null>,
  error: Annotation<string | null>,
});

type AnalyseStateType = typeof AnalyseState.State;

type AnalyseDeps = {
  input: AnalyseInput;
  tracer: AgentTraceCallback;
  parallelStep2: ParallelPhaseTrace;
  mode: AnalyseMode;
  requestId: string;
};

function invokeConfig(deps: AnalyseDeps, module: string) {
  return {
    callbacks: [deps.tracer],
    tags: [`node:${module}`, `mode:${deps.mode}`],
    metadata: { analyseNode: module, analyseMode: deps.mode },
  };
}

const BasicOutSchema = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  basicInfo: BasicInfoSchema.optional(),
});

const SkillsOutSchema = z.object({
  skills: z.array(SkillDtoSchema).default([]),
});

const ProjectsOutSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  companies: z.array(CompanySchema).default([]),
});

function normalizeSkills(skills: Resume['skills']): Resume['skills'] {
  return (skills || []).map((s) => {
    const direction = s.direction || s.label || '';
    const description = s.description || s.content || '';
    return {
      ...s,
      direction,
      description,
      label: s.label || direction,
      content: s.content || description,
    };
  });
}

function lastAiText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m._getType() === 'ai') {
      const content = m.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((c) =>
            typeof c === 'string' ? c : 'text' in c ? String(c.text) : '',
          )
          .join('');
      }
    }
  }
  return '';
}

/** oneshot / oneshot-nothink / oneshot-tools */
async function callModuleJson(
  deps: AnalyseDeps,
  opts: {
    module: string;
    system: string;
    user: string;
    sectionCtx: string;
    draftJson: string;
  },
): Promise<unknown> {
  const enableThinking = enableThinkingFor(deps.mode);
  const base = createChatModel(
    enableThinking === undefined ? undefined : { enableThinking },
  );
  const tools = bindToolsFor(deps.mode)
    ? createAnalyseReactTools({
        knowledgeId: deps.input.knowledgeId,
        sectionText: opts.sectionCtx,
        draftJson: opts.draftJson,
      })
    : [];
  const model = tools.length ? base.bindTools(tools) : base;
  const cfg = invokeConfig(deps, opts.module);

  const systemText = tools.length
    ? `${opts.system}\n\n已绑定只读工具，但本模式要求：尽量直接输出 JSON，不要调用工具（除非缺少关键字段）。`
    : opts.system;

  const messages: BaseMessage[] = [
    new SystemMessage(systemText),
    new HumanMessage(opts.user),
  ];

  // 若模型仍发起 tool_calls，做有限轮工具循环，避免直接失败/假快速 fallback
  for (let round = 0; round < 8; round += 1) {
    const msg = await model.invoke(messages, cfg);
    const ai = msg as AIMessage;
    const toolCalls = ai.tool_calls ?? [];
    if (!toolCalls.length) {
      const text =
        typeof ai.content === 'string'
          ? ai.content
          : String(ai.content ?? '');
      return extractJsonObject(text);
    }
    messages.push(ai);
    for (const tc of toolCalls) {
      const tool = tools.find((t) => t.name === tc.name);
      const raw = tool
        ? await tool.invoke(tc.args ?? {})
        : `未知工具: ${tc.name}`;
      messages.push(
        new ToolMessage({
          content: typeof raw === 'string' ? raw : JSON.stringify(raw),
          tool_call_id: tc.id || `${tc.name}-${round}`,
        }),
      );
    }
  }
  throw new Error(`${opts.module}: oneshot-tools 超过工具循环上限`);
}

/** ReAct：可先查原文/草稿/knowledge，最终输出 JSON */
async function callModuleReact(
  deps: AnalyseDeps,
  opts: {
    module: string;
    system: string;
    user: string;
    sectionCtx: string;
    draftJson: string;
  },
): Promise<unknown> {
  const tools = createAnalyseReactTools({
    knowledgeId: deps.input.knowledgeId,
    sectionText: opts.sectionCtx,
    draftJson: opts.draftJson,
  });
  const agent = createReactAgent({
    llm: createChatModel(),
    tools,
    prompt: `${opts.system}

你可以使用工具：
- read_source_section：查看本模块原文
- read_draft：查看规则草稿
- read_knowledge / list_knowledge：只读知识库

流程：需要时先调用工具核对，再给出最终答案。
最终回复必须是纯 JSON 对象（不要 markdown 代码块以外的说明）。`,
  });

  const threadId = `${deps.requestId}:${opts.module}`;
  const result = await agent.invoke(
    {
      messages: [
        new HumanMessage(
          `${opts.user}\n\n请在必要时调用工具后，输出本模块要求的 JSON。`,
        ),
      ],
    },
    {
      configurable: { thread_id: threadId },
      ...invokeConfig(deps, opts.module),
      recursionLimit: 40,
    },
  );

  const text = lastAiText(result.messages as BaseMessage[]);
  return extractJsonObject(text);
}

async function callModule(
  deps: AnalyseDeps,
  opts: {
    module: string;
    system: string;
    user: string;
    sectionCtx: string;
    draftJson: string;
  },
): Promise<unknown> {
  if (isReactMode(deps.mode)) {
    return callModuleReact(deps, opts);
  }
  return callModuleJson(deps, opts);
}

function refineNodeMeta(
  mode: AnalyseMode,
  name: string,
  oneshotDesc: string,
  reactDesc: string,
): { name: string; kind: NodeExecKind; desc: string } {
  if (mode === 'react') {
    return { name, kind: 'react', desc: reactDesc };
  }
  if (mode === 'oneshot-nothink') {
    return {
      name,
      kind: 'llm',
      desc: `${oneshotDesc} · enable_thinking=false`,
    };
  }
  if (mode === 'oneshot-tools') {
    return {
      name,
      kind: 'llm',
      desc: `${oneshotDesc} · bindTools（对照）`,
    };
  }
  return { name, kind: 'llm', desc: oneshotDesc };
}

/** step1：规则抽取草稿 */
async function extractCodeNode(
  state: AnalyseStateType,
  deps: AnalyseDeps,
): Promise<Partial<AnalyseStateType>> {
  return runNode(
    {
      name: 'extract_code',
      kind: 'code',
      desc: '规则抽取简历草稿（无大模型）',
    },
    async () => {
      const { input } = deps;
      let seed = state.draft;
      if (input.resume) seed = input.resume;
      if (input.knowledgeId) {
        const entry = getKnowledge(input.knowledgeId);
        if (entry?.resume) seed = entry.resume;
      }

      const { draft, sections, sourceText } = extractResumeDraft(
        state.sourceText || state.message,
        seed,
      );

      const mergedSource =
        sourceText.length > 50
          ? sourceText
          : `${state.message}\n${sourceText}`;

      clog(
        'flow',
        `extract_code result name=${draft.basicInfo?.name || ''} skills=${draft.skills.length} projects=${draft.projects.length}`,
      );
      clog(
        'flow',
        'step2 fan-out → refine_basicInfo | refine_skills | refine_projects',
      );

      return {
        draft,
        sourceText: mergedSource,
        sectionBlob: sections as Record<string, string[]>,
        patches: [],
        resume: null,
        error: null,
      };
    },
  );
}

/** step2 并行：基本信息 */
async function refineBasicInfoNode(
  state: AnalyseStateType,
  deps: AnalyseDeps,
): Promise<Partial<AnalyseStateType>> {
  return runNode(
    refineNodeMeta(
      deps.mode,
      'refine_basicInfo',
      'LLM 补全基本信息（单次调用，非 ReAct）',
      'ReAct 补全基本信息（可调 read_source_section / read_draft / knowledge）',
    ),
    async () => {
      const { parallelStep2 } = deps;
      parallelStep2.enter('refine_basicInfo');
      const ctx = sectionText(
        state.sectionBlob,
        ['basic', '_preamble', 'education', 'summary'],
        state.sourceText,
      );
      const draftJson = JSON.stringify(
        {
          name: state.draft.name,
          title: state.draft.title,
          basicInfo: state.draft.basicInfo,
        },
        null,
        2,
      );
      try {
        const raw = await callModule(deps, {
          module: 'refine_basicInfo',
          system:
            '你是简历解析器。只输出 JSON：{name?,title?,basicInfo:{name,phone,email,age,educations:[{school,degree,date}]}}。不虚构；缺省用空串/空数组；年龄未知用 null。',
          user: `【规则草稿】\n${draftJson}\n\n【原文片段】\n${ctx}\n\n【用户要求】\n${state.message}`,
          sectionCtx: ctx,
          draftJson,
        });
        const parsed = BasicOutSchema.parse(raw);
        parallelStep2.leave('refine_basicInfo', true);
        return {
          patches: [
            {
              module: 'basicInfo' as const,
              name: parsed.name,
              title: parsed.title,
              basicInfo: parsed.basicInfo,
            },
          ],
        };
      } catch (err) {
        if (isFatalLlmConfigError(err)) throw err;
        clog(
          'warn',
          `refine_basicInfo fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
        parallelStep2.leave('refine_basicInfo', false);
        return {
          patches: [
            {
              module: 'basicInfo' as const,
              basicInfo: state.draft.basicInfo,
            },
          ],
        };
      }
    },
  );
}

/** step2 并行：技能 */
async function refineSkillsNode(
  state: AnalyseStateType,
  deps: AnalyseDeps,
): Promise<Partial<AnalyseStateType>> {
  return runNode(
    refineNodeMeta(
      deps.mode,
      'refine_skills',
      'LLM 提取技能（单次调用，非 ReAct）',
      'ReAct 提取技能（可调 read_source_section / read_draft / knowledge）',
    ),
    async () => {
      const { parallelStep2 } = deps;
      parallelStep2.enter('refine_skills');
      const ctx = sectionText(
        state.sectionBlob,
        ['skills', 'summary'],
        state.sourceText,
      );
      const draftJson = JSON.stringify(state.draft.skills, null, 2);
      try {
        const raw = await callModule(deps, {
          module: 'refine_skills',
          system:
            '你是简历技能提取器。只输出 JSON：{skills:[{label,content}]}（也可 direction/description）。按方向归类，content 可直接上简历。不虚构。',
          user: `【规则草稿 skills】\n${draftJson}\n\n【原文片段】\n${ctx}\n\n【用户要求】\n${state.message}`,
          sectionCtx: ctx,
          draftJson,
        });
        const parsed = SkillsOutSchema.parse(raw);
        parallelStep2.leave('refine_skills', true);
        return {
          patches: [{ module: 'skills' as const, skills: parsed.skills }],
        };
      } catch (err) {
        if (isFatalLlmConfigError(err)) throw err;
        clog(
          'warn',
          `refine_skills fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
        parallelStep2.leave('refine_skills', false);
        return {
          patches: [{ module: 'skills' as const, skills: state.draft.skills }],
        };
      }
    },
  );
}

/** step2 并行：项目 / 公司 */
async function refineProjectsNode(
  state: AnalyseStateType,
  deps: AnalyseDeps,
): Promise<Partial<AnalyseStateType>> {
  return runNode(
    refineNodeMeta(
      deps.mode,
      'refine_projects',
      'LLM 提取项目/公司（单次调用，非 ReAct）',
      'ReAct 提取项目/公司（可调 read_source_section / read_draft / knowledge）',
    ),
    async () => {
      const { parallelStep2 } = deps;
      parallelStep2.enter('refine_projects');
      const ctx = sectionText(
        state.sectionBlob,
        ['projects', 'work'],
        state.sourceText,
      );
      const draftJson = JSON.stringify(
        {
          projects: state.draft.projects,
          companies: state.draft.companies,
        },
        null,
        2,
      );
      try {
        const raw = await callModule(deps, {
          module: 'refine_projects',
          system:
            '你是简历项目提取器。只输出 JSON：{projects:[{name,org,startDate,endDate,description,responsibilities:[{label,text}],achievements:[{label,text}]}],companies:[{name,roleTitle,startDate,endDate,projects:[]}]}。进行中 endDate 用 present。不虚构。',
          user: `【规则草稿】\n${draftJson}\n\n【原文片段】\n${ctx}\n\n【用户要求】\n${state.message}`,
          sectionCtx: ctx,
          draftJson,
        });
        const parsed = ProjectsOutSchema.parse(raw);
        parallelStep2.leave('refine_projects', true);
        return {
          patches: [
            {
              module: 'projects' as const,
              projects: parsed.projects,
              companies: parsed.companies,
            },
          ],
        };
      } catch (err) {
        if (isFatalLlmConfigError(err)) throw err;
        clog(
          'warn',
          `refine_projects fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
        parallelStep2.leave('refine_projects', false);
        return {
          patches: [
            {
              module: 'projects' as const,
              projects: state.draft.projects,
              companies: state.draft.companies,
            },
          ],
        };
      }
    },
  );
}

/** step3：合并各模块 patch */
async function mergeNode(
  state: AnalyseStateType,
): Promise<Partial<AnalyseStateType>> {
  return runNode(
    {
      name: 'merge',
      kind: 'code',
      desc: '合并各模块 patch 为最终 Resume（无大模型）',
    },
    async () => {
      let resume: Resume = { ...state.draft };

      for (const p of state.patches) {
        if (p.module === 'basicInfo') {
          if (p.basicInfo) resume.basicInfo = p.basicInfo;
          if (p.name) resume.name = p.name;
          if (p.title) resume.title = p.title;
          if (!resume.name && resume.basicInfo?.name) {
            resume.name = `${resume.basicInfo.name}的简历`;
          }
        }
        if (p.module === 'skills' && p.skills) {
          resume.skills = normalizeSkills(p.skills);
        }
        if (p.module === 'projects') {
          if (p.projects) resume.projects = p.projects;
          if (p.companies) resume.companies = p.companies;
        }
      }

      resume.skills = normalizeSkills(resume.skills || []);
      if (!resume.companies?.length && resume.projects?.length) {
        const byOrg = new Map<string, Resume['projects']>();
        for (const proj of resume.projects) {
          const org = proj.org || '未命名公司';
          if (!byOrg.has(org)) byOrg.set(org, []);
          byOrg.get(org)!.push(proj);
        }
        resume.companies = [...byOrg.entries()].map(([name, projects]) => ({
          name,
          roleTitle: '',
          startDate: projects[0]?.startDate || '',
          endDate: projects[projects.length - 1]?.endDate || '',
          projects,
        }));
      }

      resume.projectRefs = (resume.projects || [])
        .map((p, i) => (p.id ? { projectId: p.id, sortOrder: i } : null))
        .filter(Boolean) as Resume['projectRefs'];

      resume = ResumeSchema.parse(resume);
      return { resume, error: null };
    },
  );
}

function buildAnalyseGraph(deps: AnalyseDeps) {
  return new StateGraph(AnalyseState)
    .addNode('extract_code', (state) => extractCodeNode(state, deps))
    .addNode('refine_basicInfo', (state) => refineBasicInfoNode(state, deps))
    .addNode('refine_skills', (state) => refineSkillsNode(state, deps))
    .addNode('refine_projects', (state) => refineProjectsNode(state, deps))
    .addNode('merge', (state) => mergeNode(state))
    .addEdge(START, 'extract_code')
    .addEdge('extract_code', 'refine_basicInfo')
    .addEdge('extract_code', 'refine_skills')
    .addEdge('extract_code', 'refine_projects')
    .addEdge('refine_basicInfo', 'merge')
    .addEdge('refine_skills', 'merge')
    .addEdge('refine_projects', 'merge')
    .addEdge('merge', END)
    .compile();
}

/**
 * LangGraph 三阶段（oneshot / react 共用同一图与顺序）：
 * 1. extract_code — 规则抽取草稿
 * 2. refine_* — 按模块并行（oneshot=单次 LLM；react=createReactAgent）
 * 3. merge — 合并返回 Resume
 */
async function runAnalyseInternal(
  input: AnalyseInput,
  mode: AnalyseMode,
): Promise<AnalyseResult> {
  const requestId = input.requestId?.trim() || randomUUID();
  const tracer = new AgentTraceCallback();
  const analyseStarted = nowMs();
  const label = modeLabel(mode);
  beginRunClock(label);

  clog(
    'analyse',
    `begin mode=${mode} requestId=${requestId} knowledgeId=${input.knowledgeId ?? ''}`,
  );

  try {
    const deps: AnalyseDeps = {
      input,
      tracer,
      mode,
      requestId,
      parallelStep2: new ParallelPhaseTrace([
        'refine_basicInfo',
        'refine_skills',
        'refine_projects',
      ]),
    };
    const app = buildAnalyseGraph(deps);
    const seedDraft = input.resume || ResumeSchema.parse({});
    const finalState = await app.invoke(
      {
        requestId,
        knowledgeId: input.knowledgeId,
        sourceText: input.message,
        message: input.message,
        draft: seedDraft,
        sectionBlob: {},
        patches: [],
        resume: null,
        error: null,
      },
      { callbacks: [tracer] },
    );

    if (!finalState.resume) {
      throw new Error(finalState.error || 'analyse 未生成 resume');
    }

    const wallMs = Date.now() - analyseStarted;
    printNodeSummary(label, wallMs);
    clog(
      'analyse',
      `end mode=${mode} requestId=${requestId} name=${finalState.resume.name || finalState.resume.basicInfo?.name || ''} ${elapsedSuffix(analyseStarted)} ${formatTokens(tracer.getTokenUsage())} peakConcurrentModels=${tracer.getPeakConcurrentModels()}`,
    );

    return {
      requestId,
      knowledgeId: input.knowledgeId,
      resume: finalState.resume,
      mode,
      metrics: {
        wallMs,
        peakConcurrentModels: tracer.getPeakConcurrentModels(),
        tokens: tracer.getTokenUsage(),
        nodes: snapshotNodeMetrics(getNodeRecords()),
      },
    };
  } finally {
    endRunClock();
  }
}

/** 默认：并行单次 LLM；也可传入 mode 跑对照（oneshot-nothink / oneshot-tools） */
export async function runAnalyse(input: AnalyseInput): Promise<AnalyseResult> {
  return runAnalyseInternal(input, input.mode ?? 'oneshot');
}

/** 新入口：顺序与 analyse 相同，refine 节点用 ReAct + tools */
export async function runAnalyseReact(
  input: AnalyseInput,
): Promise<AnalyseResult> {
  return runAnalyseInternal({ ...input, mode: 'react' }, 'react');
}
