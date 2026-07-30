import { ChatOpenAI } from '@langchain/openai';

function env(name: string, fallbackName?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallbackName) {
    return process.env[fallbackName]?.trim() || undefined;
  }
  return undefined;
}

function isRetriableLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /premature close|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|502|503|504/i.test(
    msg,
  );
}

async function withLlmRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableLlmError(err) || attempt === retries) throw err;
      const waitMs = Math.min(8000, 500 * 2 ** (attempt - 1));
      console.warn(
        `[llm] retry ${attempt}/${retries} after ${waitMs}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export type CreateChatModelOptions = {
  /**
   * 显式开关思考链（Qwen3 / 兼容网关常用 enable_thinking）。
   * undefined = 不传该字段（走服务商默认）；也可用环境变量 LLM_ENABLE_THINKING=0/1。
   * 注意：部分预览模型（如 qwen3.*-preview）会强制 enable_thinking=true，传 false 会 400。
   */
  enableThinking?: boolean;
};

function resolveEnableThinking(
  opts?: CreateChatModelOptions,
): boolean | undefined {
  if (opts && 'enableThinking' in opts && opts.enableThinking !== undefined) {
    return opts.enableThinking;
  }
  const raw = env('LLM_ENABLE_THINKING')?.toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
    return false;
  }
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') {
    return true;
  }
  return undefined;
}

export function createChatModel(opts?: CreateChatModelOptions) {
  const apiKey = env('LLM_API_KEY', 'OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('缺少环境变量 LLM_API_KEY 或 OPENAI_API_KEY');
  }

  const timeoutRaw = env('OPENAI_TIMEOUT_MS');
  // 阿里云 MaaS 长文本易 Premature close；默认 3 分钟，可用环境变量覆盖
  const timeout =
    timeoutRaw && Number(timeoutRaw) > 0 ? Number(timeoutRaw) : 180_000;
  const maxRetriesRaw = env('OPENAI_MAX_RETRIES');
  const maxRetries =
    maxRetriesRaw && Number(maxRetriesRaw) >= 0 ? Number(maxRetriesRaw) : 3;

  const enableThinking = resolveEnableThinking(opts);
  const modelKwargs: Record<string, unknown> = {};
  if (enableThinking !== undefined) {
    // OpenAI 兼容网关（含阿里云 MaaS / DashScope）常见字段
    modelKwargs.enable_thinking = enableThinking;
  }

  const model = new ChatOpenAI({
    apiKey,
    model: env('LLM_MODEL', 'OPENAI_MODEL') || 'gpt-4o-mini',
    temperature: 0.2,
    timeout,
    maxRetries,
    ...(Object.keys(modelKwargs).length ? { modelKwargs } : {}),
    configuration: {
      baseURL: env('LLM_BASE_URL', 'OPENAI_BASE_URL'),
    },
  });

  // LangChain 默认重试不一定覆盖 Premature close，再包一层
  const originalInvoke = model.invoke.bind(model);
  model.invoke = ((...args: Parameters<typeof originalInvoke>) =>
    withLlmRetry(() => originalInvoke(...args), maxRetries + 1)) as typeof model.invoke;

  return model;
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
