import { ChatOpenAI } from '@langchain/openai';

function env(name: string, fallbackName?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallbackName) {
    return process.env[fallbackName]?.trim() || undefined;
  }
  return undefined;
}

export function createChatModel() {
  const apiKey = env('LLM_API_KEY', 'OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('缺少环境变量 LLM_API_KEY 或 OPENAI_API_KEY');
  }

  const timeoutRaw = env('OPENAI_TIMEOUT_MS');
  const timeout =
    timeoutRaw && Number(timeoutRaw) > 0 ? Number(timeoutRaw) : undefined;

  return new ChatOpenAI({
    apiKey,
    model: env('LLM_MODEL', 'OPENAI_MODEL') || 'gpt-4o-mini',
    temperature: 0.2,
    timeout,
    configuration: {
      baseURL: env('LLM_BASE_URL', 'OPENAI_BASE_URL'),
    },
  });
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('模型输出中未找到 JSON 对象');
  }
  return JSON.parse(raw.slice(start, end + 1));
}
