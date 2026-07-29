import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createChatModel, extractJsonObject } from '../llm.js';

const SkillSchema = z.object({
  label: z.string(),
  content: z.string(),
});

const BasicInfoSchema = z.object({
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  age: z.number().optional().nullable(),
  educations: z
    .array(
      z.object({
        school: z.string(),
        degree: z.string(),
        date: z.string(),
      }),
    )
    .default([]),
});

const EducationSchema = z.object({
  school: z.string(),
  degree: z.string(),
  date: z.string(),
});

const ProjectSchema = z.object({
  name: z.string(),
  org: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
  description: z.string(),
  responsibilities: z
    .array(
      z.object({
        label: z.string(),
        text: z.string(),
      }),
    )
    .default([]),
  achievements: z
    .array(
      z.object({
        label: z.string(),
        text: z.string(),
      }),
    )
    .default([]),
});

const ResultSchema = z.object({
  basicInfo: BasicInfoSchema.optional(),
  educations: z.array(EducationSchema).optional(),
  skills: z.array(SkillSchema).optional(),
  projectSuggestions: z
    .array(
      z.object({
        projectId: z.string(),
        project: ProjectSchema,
      }),
    )
    .default([]),
});

const ResumeState = Annotation.Root({
  resume: Annotation<unknown>,
  targetRole: Annotation<string>,
  instruction: Annotation<string>,
  analysis: Annotation<string>,
  draft: Annotation<string>,
  result: Annotation<z.infer<typeof ResultSchema> | null>,
  error: Annotation<string | null>,
});

export async function runOptimizeResume(
  resume: unknown,
  targetRole = '',
  instruction = '',
) {
  const model = createChatModel();

  const graph = new StateGraph(ResumeState)
    .addNode('analyze', async (state) => {
      const msg = await model.invoke([
        {
          role: 'system',
          content:
            '你是资深技术简历顾问。分析整份简历在目标岗位下的问题（技能匹配、项目表达、基础信息）。用中文输出简短分析要点，不要 JSON。',
        },
        {
          role: 'user',
          content: `目标岗位：${state.targetRole || '全栈开发'}\n要求：${state.instruction || '整体润色'}\n\n简历：\n${JSON.stringify(state.resume, null, 2)}`,
        },
      ]);
      return { analysis: String(msg.content ?? '') };
    })
    .addNode('rewrite_modules', async (state) => {
      const msg = await model.invoke([
        {
          role: 'system',
          content:
            '根据分析优化简历模块。只输出 JSON：{basicInfo?,educations?,skills:[{label,content}]?,projectSuggestions:[{projectId,project}]}。不要虚构经历；可改写表达。projectSuggestions 仅包含需要改动的项目，projectId 必须来自原简历 projects/projectRefs。project 字段：name,org,startDate,endDate,description,responsibilities,achievements。',
        },
        {
          role: 'user',
          content: `分析：\n${state.analysis}\n\n原简历：\n${JSON.stringify(state.resume, null, 2)}`,
        },
      ]);
      return { draft: String(msg.content ?? '') };
    })
    .addNode('validate', async (state) => {
      try {
        return {
          result: ResultSchema.parse(extractJsonObject(state.draft)),
          error: null,
        };
      } catch (err) {
        return {
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
    .addEdge(START, 'analyze')
    .addEdge('analyze', 'rewrite_modules')
    .addEdge('rewrite_modules', 'validate')
    .addEdge('validate', END);

  const app = graph.compile();
  let state = await app.invoke({
    resume,
    targetRole,
    instruction,
    analysis: '',
    draft: '',
    result: null,
    error: null,
  });

  if (!state.result) {
    const fix = await model.invoke([
      {
        role: 'system',
        content:
          '修正为合法 JSON：{basicInfo?,educations?,skills?,projectSuggestions:[{projectId,project}]}',
      },
      { role: 'user', content: `${state.draft}\n\nerror:${state.error}` },
    ]);
    state = {
      ...state,
      result: ResultSchema.parse(extractJsonObject(String(fix.content ?? ''))),
      error: null,
    };
  }

  return state.result;
}
