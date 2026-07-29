import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createChatModel, extractJsonObject } from '../llm.js';
import { ResumeSchema, type Resume } from '../schemas/resume.js';

const IngestState = Annotation.Root({
  sourceText: Annotation<string>,
  draft: Annotation<string>,
  result: Annotation<Resume | null>,
  error: Annotation<string | null>,
});

const SYSTEM = `你是简历结构化专家。将用户提供的简历/项目原文，提炼为 resume-server 可读的 JSON，字段如下：
{
  "name": "简历名称",
  "title": "求职方向或标题",
  "basicInfo": {
    "name": "", "phone": "", "email": "", "age": null,
    "educations": [{"school":"","degree":"","date":""}]
  },
  "skills": [{"label":"方向如前端","content":"技能描述"} 或 {"direction":"...","description":"..."}],
  "companies": [{
    "name":"公司", "roleTitle":"职位", "startDate":"", "endDate":"",
    "projects": []
  }],
  "projects": [{
    "name":"", "org":"公司或组织", "startDate":"", "endDate":"",
    "description":"",
    "responsibilities":[{"label":"","text":""}],
    "achievements":[{"label":"","text":""}]
  }],
  "projectRefs": []
}
规则：
1. 只输出 JSON，不要 Markdown。
2. 不虚构经历；原文缺失的字段用空字符串或空数组。
3. endDate 进行中用 "present"。
4. 技能优先用 label/content；若原文是方向+描述也可。
5. 项目职责/成果拆成短条目，文案用中文。`;

export async function runIngestResume(sourceText: string): Promise<Resume> {
  const model = createChatModel();
  const truncated =
    sourceText.length > 30000
      ? `${sourceText.slice(0, 30000)}\n\n[文本已截断]`
      : sourceText;

  const graph = new StateGraph(IngestState)
    .addNode('structure', async (state) => {
      const msg = await model.invoke([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: state.sourceText },
      ]);
      return { draft: String(msg.content ?? '') };
    })
    .addNode('validate', async (state) => {
      try {
        return {
          result: ResumeSchema.parse(extractJsonObject(state.draft)),
          error: null,
        };
      } catch (err) {
        return {
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
    .addEdge(START, 'structure')
    .addEdge('structure', 'validate')
    .addEdge('validate', END);

  const app = graph.compile();
  let state = await app.invoke({
    sourceText: truncated,
    draft: '',
    result: null,
    error: null,
  });

  if (!state.result) {
    const fix = await model.invoke([
      {
        role: 'system',
        content:
          '将内容修正为合法 Resume JSON（basicInfo/skills/companies/projects/projectRefs）。只输出 JSON。',
      },
      {
        role: 'user',
        content: `${state.draft}\n\nerror:${state.error}`,
      },
    ]);
    state = {
      ...state,
      result: ResumeSchema.parse(extractJsonObject(String(fix.content ?? ''))),
      error: null,
    };
  }

  return state.result;
}
