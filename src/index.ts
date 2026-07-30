import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { runAnalyse, runAnalyseReact } from './graphs/analyse.js';
import { runChat } from './graphs/chatAgent.js';
import {
  getKnowledgeDir,
  loadKnowledgeFromDisk,
} from './knowledge/store.js';
import { loadEnvFile } from './loadEnv.js';
import { extractTextFromBuffer } from './parsers/document.js';
import { ResumeSchema } from './schemas/resume.js';

loadEnvFile();

const app = express();
const port = Number(process.env.PORT || 7001);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const knowledgeCount = loadKnowledgeFromDisk();
console.log(
  `[agent] knowledge loaded: ${knowledgeCount} from ${getKnowledgeDir()}`,
);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

async function loadFileFromPath(filePath: string): Promise<{
  buffer: Buffer;
  fileName: string;
  contentType?: string;
}> {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error('filePath 不能为空');
  }

  if (
    trimmed.startsWith('/api/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) {
    const base = (
      process.env.RESUME_SERVER_BASE_URL || 'http://localhost:8080'
    ).replace(/\/$/, '');
    const url = trimmed.startsWith('http') ? trimmed : `${base}${trimmed}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`读取附件失败 ${res.status}: ${body || url}`);
    }
    const ab = await res.arrayBuffer();
    const disposition = res.headers.get('content-disposition') || '';
    const matched = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    const fileName = matched
      ? decodeURIComponent(matched[1])
      : basename(new URL(url).pathname) || 'upload.bin';
    return {
      buffer: Buffer.from(ab),
      fileName,
      contentType: res.headers.get('content-type') || undefined,
    };
  }

  const abs = resolve(trimmed);
  if (!existsSync(abs)) {
    throw new Error(`文件不存在: ${abs}`);
  }
  return {
    buffer: readFileSync(abs),
    fileName: basename(abs),
  };
}

async function resolveMessageWithFile(req: express.Request): Promise<{
  message: string;
  knowledgeId?: string;
  resume?: ReturnType<typeof ResumeSchema.parse>;
}> {
  let message = String(req.body?.message || '').trim();
  const knowledgeId = req.body?.knowledgeId
    ? String(req.body.knowledgeId)
    : undefined;
  const filePath = req.body?.filePath ? String(req.body.filePath).trim() : '';

  let resume;
  if (req.body?.resume) {
    const raw =
      typeof req.body.resume === 'string'
        ? JSON.parse(req.body.resume)
        : req.body.resume;
    resume = ResumeSchema.parse(raw);
  }

  let fileBuffer: Buffer | undefined;
  let fileName = 'upload.bin';
  let contentType: string | undefined;

  if (req.file) {
    fileBuffer = req.file.buffer;
    fileName = req.file.originalname || fileName;
    contentType = req.file.mimetype;
  } else if (filePath) {
    const loaded = await loadFileFromPath(filePath);
    fileBuffer = loaded.buffer;
    fileName = loaded.fileName;
    contentType = loaded.contentType;
  }

  if (fileBuffer) {
    const extracted = await extractTextFromBuffer(
      fileBuffer,
      fileName,
      contentType,
    );
    // 过长正文易导致 MaaS 连接 Premature close；截断后仍保留主体经历
    const maxChars = Number(process.env.ANALYSE_MAX_FILE_CHARS || 28000);
    let text = extracted.text || '';
    if (maxChars > 0 && text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n\n[文本已截断，原文约 ${extracted.text.length} 字]`;
    }
    const fileNote = `【用户上传文件 ${fileName}】\n${text}`;
    message = message ? `${message}\n\n${fileNote}` : fileNote;
  }

  return { message, knowledgeId, resume };
}

async function handleAnalyse(
  req: express.Request,
  res: express.Response,
  mode: 'oneshot' | 'react',
) {
  try {
    const requestId = String(
      req.body?.requestId || req.body?.threadId || randomUUID(),
    );
    const { message, knowledgeId, resume } = await resolveMessageWithFile(req);
    if (!message.trim()) {
      res.status(400).json({ message: 'message 不能为空（或上传文件）' });
      return;
    }
    const payload = {
      message:
        message.includes('【分析') || message.includes('Resume')
          ? message
          : `请将以下材料分析/结构化为一份完整简历。\n\n${message}`,
      knowledgeId,
      resume,
      requestId,
    };
    const result =
      mode === 'react'
        ? await runAnalyseReact(payload)
        : await runAnalyse(payload);
    // 不返回 messages / toolResults
    res.json({
      requestId: result.requestId,
      knowledgeId: result.knowledgeId,
      resume: result.resume,
      mode: result.mode,
    });
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 简历分析入口：extract → 并行 refine(单次 LLM) → merge。
 * 对外只返回 { requestId, knowledgeId?, resume, mode }。
 */
app.post('/v1/analyse', upload.single('file'), (req, res) =>
  handleAnalyse(req, res, 'oneshot'),
);

/**
 * 简历分析 ReAct 入口：顺序与 /v1/analyse 相同，
 * refine_* 使用 createReactAgent（可调 tools）。
 */
app.post('/v1/analyse-react', upload.single('file'), (req, res) =>
  handleAnalyse(req, res, 'react'),
);

/**
 * 多轮对话入口（自然语言回复，非简历分析主入口）。
 * body: { message, threadId?, knowledgeId?, resume?, filePath? }
 */
app.post('/v1/chat', upload.single('file'), async (req, res) => {
  try {
    const threadId = String(req.body?.threadId || randomUUID());
    const { message, knowledgeId } = await resolveMessageWithFile(req);
    if (!message.trim()) {
      res.status(400).json({ message: 'message 不能为空（或上传文件）' });
      return;
    }
    const result = await runChat({ threadId, message, knowledgeId });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(port, () => {
  console.log(`[agent] listening on http://localhost:${port}`);
  console.log(
    `[agent] API: GET /health , POST /v1/analyse , POST /v1/analyse-react , POST /v1/chat`,
  );
});
