import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createChatModel, extractJsonObject } from '../llm.js';

const ProjectWorkSchema = z.object({
  label: z.string(),
  text: z.string(),
});

const ProjectSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  org: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
  description: z.string(),
  responsibilities: z.array(ProjectWorkSchema).default([]),
  achievements: z.array(ProjectWorkSchema).default([]),
});

const OptimizeState = Annotation.Root({
  project: Annotation<z.infer<typeof ProjectSchema>>,
  instruction: Annotation<string>,
  draft: Annotation<string>,
  result: Annotation<z.infer<typeof ProjectSchema> | null>,
  error: Annotation<string | null>,
});

export async function runOptimizeProject(
  project: z.infer<typeof ProjectSchema>,
  instruction = '',
) {
  const model = createChatModel();

  const graph = new StateGraph(OptimizeState)
    .addNode('rewrite', async (state) => {
      const msg = await model.invoke([
        {
          role: 'system',
          content:
            '你是简历项目经历优化专家。在不虚构事实的前提下，优化项目简介、职责与成果：更简洁、更有结果导向、动词开头。只输出完整项目 JSON（字段与输入一致，可保留 id）。',
        },
        {
          role: 'user',
          content: `优化要求：${state.instruction || '默认优化清晰度与量化表达'}\n\n原项目：\n${JSON.stringify(state.project, null, 2)}`,
        },
      ]);
      return { draft: String(msg.content ?? '') };
    })
    .addNode('validate', async (state) => {
      try {
        const parsed = ProjectSchema.parse(extractJsonObject(state.draft));
        if (state.project.id) {
          parsed.id = state.project.id;
        }
        return { result: parsed, error: null };
      } catch (err) {
        return {
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
    .addEdge(START, 'rewrite')
    .addEdge('rewrite', 'validate')
    .addEdge('validate', END);

  const app = graph.compile();
  let state = await app.invoke({
    project,
    instruction,
    draft: '',
    result: null,
    error: null,
  });

  if (!state.result) {
    const fix = await model.invoke([
      {
        role: 'system',
        content:
          '将内容修正为合法项目 JSON，字段：id?,name,org,startDate,endDate,description,responsibilities,achievements',
      },
      { role: 'user', content: `${state.draft}\n\nerror:${state.error}` },
    ]);
    const parsed = ProjectSchema.parse(extractJsonObject(String(fix.content ?? '')));
    if (project.id) parsed.id = project.id;
    state = { ...state, result: parsed, error: null };
  }

  return { project: state.result };
}
