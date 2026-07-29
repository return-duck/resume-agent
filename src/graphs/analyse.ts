import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { randomUUID } from 'node:crypto';
import { extractJsonObject, createChatModel } from '../llm.js';
import {
  formatKnowledgeForPrompt,
  getKnowledge,
} from '../knowledge/store.js';
import { AgentTraceCallback, agentLog } from '../logging/agentCallbacks.js';
import { ResumeSchema, type Resume } from '../schemas/resume.js';
import { createReadKnowledgeTools } from '../tools/readKnowledge.js';

export interface AnalyseInput {
  message: string;
  knowledgeId?: string;
  /** 本轮临时上下文，不写入 knowledge */
  resume?: Resume;
  requestId?: string;
}

/** 对外只返回结构化简历，不暴露调用链 */
export interface AnalyseResult {
  requestId: string;
  knowledgeId?: string;
  resume: Resume;
}

const RESUME_JSON_SPEC = `最终必须只输出一个 Resume JSON 对象（可与 resume-server ResumeDto 对齐），字段：
{
  "id"?: string,
  "basicInfoId"?: string,
  "name": string,
  "title": string,
  "variant": string,
  "basicInfo": {
    "id"?: string,
    "name": string, "phone": string, "email": string, "age"?: number|null,
    "educations": [{"school":"","degree":"","date":""}]
  },
  "skills": [
    {"label":"方向","content":"描述"} 或 {"direction":"方向","description":"描述"}
  ],
  "companies": [{
    "id"?: string, "name":"", "roleTitle":"", "startDate":"", "endDate":"",
    "projects": [/* 同 projects 项 */]
  }],
  "projectRefs": [{"projectId":"","sortOrder":0}],
  "projects": [{
    "id"?: string, "companyId"?: string,
    "name":"", "org":"", "startDate":"", "endDate":"",
    "description":"",
    "responsibilities":[{"label":"","text":""}],
    "achievements":[{"label":"","text":""}]
  }]
}`;

function buildSystemPrompt(knowledgeId?: string): string {
  return `你是简历结构化分析 Agent。

你可以在内部使用工具（如 read_knowledge）收集信息，但面向用户的最终答案必须是且仅是一份 Resume JSON。
不要输出 Markdown、不要解释调用过程、不要输出工具名称。

规则：
1. 不写入 / 修改 knowledge；read_knowledge 只读。
2. 不虚构经历；原文缺失字段用空字符串或空数组。
3. endDate 进行中用 "present"。
4. ${RESUME_JSON_SPEC}
${knowledgeId ? `5. 默认 knowledgeId=${knowledgeId}（只读）。` : ''}`;
}

function buildUserMessage(input: AnalyseInput): string {
  const parts: string[] = [];
  if (input.knowledgeId) {
    const entry = getKnowledge(input.knowledgeId);
    if (entry) {
      parts.push(
        '【已注入 knowledge 摘要，仍可调用 read_knowledge 复核】\n' +
          formatKnowledgeForPrompt(entry),
      );
    } else {
      parts.push(`【knowledge】未找到 knowledgeId=${input.knowledgeId}`);
    }
  }
  if (input.resume) {
    parts.push(
      '【本轮临时简历上下文（未入库）】\n' +
        JSON.stringify(input.resume, null, 2),
    );
  }
  parts.push(`【分析请求】\n${input.message}`);
  parts.push('请在需要时调用工具，最后只输出 Resume JSON。');
  return parts.join('\n\n');
}

function lastAiText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m._getType() === 'ai') {
      // 跳过仅含 tool_calls、无正文的中间轮
      const content = m.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((c) =>
                  typeof c === 'string'
                    ? c
                    : c && typeof c === 'object' && 'text' in c
                      ? String((c as { text: unknown }).text)
                      : '',
                )
                .join('')
            : '';
      if (text.trim()) return text;
    }
  }
  return '';
}

function parseResume(text: string): Resume {
  return ResumeSchema.parse(extractJsonObject(text));
}

/** 兼容 Java SkillDto(direction/description) 与前端 label/content */
function normalizeResumeSkills(resume: Resume): Resume {
  resume.skills = (resume.skills || []).map((s) => {
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
  return resume;
}

/**
 * 分析入口：内部可 ReAct；对外只返回 Resume JSON 结构。
 */
export async function runAnalyse(input: AnalyseInput): Promise<AnalyseResult> {
  const requestId = input.requestId?.trim() || randomUUID();
  const model = createChatModel();
  const tracer = new AgentTraceCallback();

  agentLog(
    'analyse.begin',
    `requestId=${requestId} knowledgeId=${input.knowledgeId ?? ''}`,
  );

  const agent = createReactAgent({
    llm: model,
    tools: createReadKnowledgeTools(input.knowledgeId),
    prompt: buildSystemPrompt(input.knowledgeId),
  });

  const result = await agent.invoke(
    { messages: [new HumanMessage(buildUserMessage(input))] },
    { callbacks: [tracer] },
  );

  const msgs = result.messages as BaseMessage[];
  let draft = lastAiText(msgs);
  let resume: Resume;

  try {
    resume = parseResume(draft);
  } catch (err) {
    agentLog(
      'model.error',
      `resume parse failed, fixing… ${err instanceof Error ? err.message : String(err)}`,
    );
    const fix = await model.invoke(
      [
        {
          role: 'system',
          content:
            '将内容修正为合法 Resume JSON（对齐 resume-server ResumeDto）。只输出 JSON。\n' +
            RESUME_JSON_SPEC,
        },
        { role: 'user', content: draft || JSON.stringify(msgs.slice(-4)) },
      ],
      { callbacks: [tracer] },
    );
    draft = String(fix.content ?? '');
    resume = parseResume(draft);
  }

  resume = normalizeResumeSkills(resume);

  agentLog(
    'analyse.end',
    `requestId=${requestId} name=${resume.name || resume.basicInfo?.name || ''}`,
  );

  return {
    requestId,
    knowledgeId: input.knowledgeId,
    resume,
  };
}
