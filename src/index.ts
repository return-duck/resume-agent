import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { runAnalyse } from './graphs/analyse.js';
import { runChat } from './graphs/chatAgent.js';
import {
  getKnowledgeDir,
  loadKnowledgeFromDisk,
} from './knowledge/store.js';
import { extractTextFromBuffer } from './parsers/document.js';
import { ResumeSchema } from './schemas/resume.js';

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

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
    const fileNote = `【用户上传文件 ${fileName}】\n${extracted.text}`;
    message = message ? `${message}\n\n${fileNote}` : fileNote;
  }

  return { message, knowledgeId, resume };
}

/**
 * 简历分析入口：内部可 ReAct；对外只返回 { requestId, knowledgeId?, resume }。
 */
app.post('/v1/analyse', upload.single('file'), async (req, res) => {
  try {
    const requestId = String(
      req.body?.requestId || req.body?.threadId || randomUUID(),
    );
    const { message, knowledgeId, resume } = await resolveMessageWithFile(req);
    if (!message.trim()) {
      res.status(400).json({ message: 'message 不能为空（或上传文件）' });
      return;
    }
    const result = await runAnalyse({
      message:
        message.includes('【分析') || message.includes('Resume')
          ? message
          : `请将以下材料分析/结构化为一份完整简历。\n\n${message}`,
      knowledgeId,
      resume,
      requestId,
    });
    // 不返回 messages / toolResults
    res.json({
      requestId: result.requestId,
      knowledgeId: result.knowledgeId,
      resume: result.resume,
    });
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

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
  console.log(`[agent] API: GET /health , POST /v1/analyse , POST /v1/chat`);
});
