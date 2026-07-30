import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { createChatModel } from '../llm.js';
import {
  AgentTraceCallback,
  beginRunClock,
  elapsedSuffix,
  endRunClock,
  formatTokens,
  nowMs,
  printNodeSummary,
  runNode,
} from '../logging/agentCallbacks.js';
import { clog } from '../logging/logger.js';
import { createReadKnowledgeTools } from '../tools/readKnowledge.js';

const checkpointer = new MemorySaver();

function systemPrompt(knowledgeId?: string) {
  return `你是简历助手，支持多轮对话。

规则：
1. 这是对话入口，用自然语言与用户交流；不要把整份简历 JSON 当作唯一回复格式（分析请走 analyse 接口）。
2. 涉及用户简历具体内容前，先 read_knowledge。
3. 默认 knowledgeId：${knowledgeId || '（未绑定，可先 list_knowledge）'}。
4. 不要编造经历；回复用中文。
5. 你不能写入或修改 knowledge。`;
}

export interface ChatInput {
  threadId: string;
  message: string;
  knowledgeId?: string;
}

export interface ChatResult {
  threadId: string;
  knowledgeId?: string;
  reply: string;
}

function getAgent(knowledgeId?: string) {
  return createReactAgent({
    llm: createChatModel(),
    tools: createReadKnowledgeTools(knowledgeId),
    checkpointer,
    prompt: systemPrompt(knowledgeId),
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

/** 多轮对话入口 */
export async function runChat(input: ChatInput): Promise<ChatResult> {
  const agent = getAgent(input.knowledgeId);
  const tracer = new AgentTraceCallback();
  const chatStarted = nowMs();
  beginRunClock('chat');
  try {
    clog(
      'chat',
      `begin threadId=${input.threadId} knowledgeId=${input.knowledgeId ?? ''}`,
    );

    const result = await runNode(
      {
        name: 'chat_react',
        kind: 'react',
        desc: '多轮对话 ReAct Agent（可调用 read_knowledge / list_knowledge）',
      },
      () =>
        agent.invoke(
          { messages: [new HumanMessage(input.message)] },
          {
            configurable: { thread_id: input.threadId },
            callbacks: [tracer],
          },
        ),
    );

    const msgs = result.messages as BaseMessage[];
    const reply = lastAiText(msgs);
    printNodeSummary('chat', Date.now() - chatStarted);
    clog(
      'chat',
      `end threadId=${input.threadId} replyChars=${reply.length} ${elapsedSuffix(chatStarted)} ${formatTokens(tracer.getTokenUsage())}`,
    );

    return {
      threadId: input.threadId,
      knowledgeId: input.knowledgeId,
      reply,
    };
  } finally {
    endRunClock();
  }
}
