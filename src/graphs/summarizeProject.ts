import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createChatModel, extractJsonObject } from '../llm.js';

const SkillSchema = z.object({
  label: z.string(),
  content: z.string(),
});

const ProjectWorkSchema = z.object({
  label: z.string(),
  text: z.string(),
});

const ProjectSchema = z.object({
  name: z.string(),
  org: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
  description: z.string(),
  responsibilities: z.array(ProjectWorkSchema).default([]),
  achievements: z.array(ProjectWorkSchema).default([]),
});

const SummarizeSchema = z.object({
  project: ProjectSchema,
  skills: z.array(SkillSchema).default([]),
});

const SummarizeState = Annotation.Root({
  inputText: Annotation<string>,
  draft: Annotation<string>,
  skillsDraft: Annotation<string>,
  result: Annotation<z.infer<typeof SummarizeSchema> | null>,
  error: Annotation<string | null>,
});

export async function runSummarizeProject(inputText: string) {
  const model = createChatModel();

  const graph = new StateGraph(SummarizeState)
    .addNode('extract_structure', async (state) => {
      const msg = await model.invoke([
        {
          role: 'system',
          content:
            '你是资深简历顾问。根据用户输入提炼结构化项目经历，只输出 JSON：{name,org,startDate,endDate,description,responsibilities:[{label,text}],achievements:[{label,text}]}。endDate 进行中用 present。文案用中文，突出量化结果与职责。',
        },
        { role: 'user', content: state.inputText },
      ]);
      return { draft: String(msg.content ?? '') };
    })
    .addNode('extract_skills', async (state) => {
      const msg = await model.invoke([
        {
          role: 'system',
          content:
            '根据项目经历 JSON，提取可写入简历「专业技能」的条目。只输出 JSON：{skills:[{label,content}]}。label 如 前端/服务端/AI/工程能力，content 简洁可直接上简历。',
        },
        { role: 'user', content: state.draft },
      ]);
      return { skillsDraft: String(msg.content ?? '') };
    })
    .addNode('validate_schema', async (state) => {
      try {
        const project = ProjectSchema.parse(extractJsonObject(state.draft));
        let skills: z.infer<typeof SkillSchema>[] = [];
        try {
          const skillsObj = extractJsonObject(state.skillsDraft) as { skills?: unknown };
          skills = z.array(SkillSchema).parse(skillsObj.skills ?? skillsObj);
        } catch {
          skills = [];
        }
        return {
          result: SummarizeSchema.parse({ project, skills }),
          error: null,
        };
      } catch (err) {
        return {
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
    .addEdge(START, 'extract_structure')
    .addEdge('extract_structure', 'extract_skills')
    .addEdge('extract_skills', 'validate_schema')
    .addEdge('validate_schema', END);

  const app = graph.compile();
  let state = await app.invoke({
    inputText,
    draft: '',
    skillsDraft: '',
    result: null,
    error: null,
  });

  if (!state.result) {
    const fix = await model.invoke([
      {
        role: 'system',
        content:
          '请把以下内容修正为合法 JSON：{project:{name,org,startDate,endDate,description,responsibilities:[{label,text}],achievements:[{label,text}]},skills:[{label,content}]}',
      },
      {
        role: 'user',
        content: `projectDraft:\n${state.draft}\n\nskillsDraft:\n${state.skillsDraft}\n\nerror:${state.error}`,
      },
    ]);
    const fixed = SummarizeSchema.parse(extractJsonObject(String(fix.content ?? '')));
    state = { ...state, result: fixed, error: null };
  }

  return state.result;
}
