import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  formatKnowledgeForPrompt,
  getKnowledge,
  listKnowledge,
} from '../knowledge/store.js';

/** 只读 knowledge 工具（analyse / chat 共用） */
export function createReadKnowledgeTools(defaultKnowledgeId?: string) {
  const readKnowledge = tool(
    async ({ knowledgeId }) => {
      const id = (knowledgeId && knowledgeId.trim()) || defaultKnowledgeId;
      if (!id) {
        const all = listKnowledge();
        if (all.length === 0) {
          return '当前没有任何 knowledge。';
        }
        return `未指定 knowledgeId。可用列表：\n${JSON.stringify(all, null, 2)}`;
      }
      const entry = getKnowledge(id);
      if (!entry) return `未找到 knowledgeId=${id}`;
      return formatKnowledgeForPrompt(entry);
    },
    {
      name: 'read_knowledge',
      description:
        '读取已入库的简历 knowledge（只读）。涉及具体简历内容前应调用。',
      schema: z.object({
        knowledgeId: z
          .string()
          .nullish()
          .describe('知识库 ID；省略则使用会话默认 ID'),
      }),
    },
  );

  const listKnowledgeTool = tool(
    async () => JSON.stringify(listKnowledge(), null, 2),
    {
      name: 'list_knowledge',
      description: '列出可用的简历 knowledge 条目。',
      schema: z.object({}),
    },
  );

  return [readKnowledge, listKnowledgeTool];
}
