import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createReadKnowledgeTools } from './readKnowledge.js';

/** analyse-react 模块级工具：查原文/草稿/knowledge */
export function createAnalyseReactTools(opts: {
  knowledgeId?: string;
  sectionText: string;
  draftJson: string;
}) {
  const readSourceSection = tool(
    async () => opts.sectionText || '(本模块原文片段为空)',
    {
      name: 'read_source_section',
      description:
        '读取本模块对应的简历原文片段（已按章节切分）。需要核对细节时调用。',
      schema: z.object({}),
    },
  );

  const readDraft = tool(async () => opts.draftJson || '{}', {
    name: 'read_draft',
    description: '读取规则抽取得到的本模块草稿 JSON，可在此基础上修正补全。',
    schema: z.object({}),
  });

  return [
    readSourceSection,
    readDraft,
    ...createReadKnowledgeTools(opts.knowledgeId),
  ];
}
