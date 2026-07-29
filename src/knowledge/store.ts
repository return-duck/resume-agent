import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Resume } from '../schemas/resume.js';
import { ResumeSchema } from '../schemas/resume.js';

export interface KnowledgeEntry {
  id: string;
  /** resume-server 可读懂的结构化简历 */
  resume: Resume;
  /** 原始文档摘录（可选，便于调试） */
  sourceText?: string;
  sourceFileName?: string;
  updatedAt: string;
}

const store = new Map<string, KnowledgeEntry>();
let loaded = false;

function knowledgeDir(): string {
  const raw = process.env.KNOWLEDGE_DIR?.trim() || './data/knowledge';
  return resolve(process.cwd(), raw);
}

/** 仅允许安全文件名，防止路径穿越 */
function safeFileId(id: string): string {
  const cleaned = id.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`非法 knowledgeId: ${id}`);
  }
  return cleaned;
}

function entryPath(id: string): string {
  return join(knowledgeDir(), `${safeFileId(id)}.json`);
}

function ensureDir() {
  const dir = knowledgeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeEntry(entry: KnowledgeEntry) {
  ensureDir();
  const target = entryPath(entry.id);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
  renameSync(tmp, target);
}

function removeEntryFile(id: string) {
  const path = entryPath(id);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function parseEntry(raw: unknown): KnowledgeEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id.trim()) return null;
  try {
    return {
      id: obj.id.trim(),
      resume: ResumeSchema.parse(obj.resume),
      sourceText: typeof obj.sourceText === 'string' ? obj.sourceText : undefined,
      sourceFileName:
        typeof obj.sourceFileName === 'string' ? obj.sourceFileName : undefined,
      updatedAt:
        typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** 从磁盘加载全部 knowledge（启动时调用；幂等） */
export function loadKnowledgeFromDisk(): number {
  ensureDir();
  store.clear();
  const dir = knowledgeDir();
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.includes('.tmp')) continue;
    const full = join(dir, name);
    try {
      const parsed = parseEntry(JSON.parse(readFileSync(full, 'utf8')));
      if (!parsed) continue;
      // 文件名与 id 不一致时以内容 id 为准
      if (basename(full) !== `${safeFileId(parsed.id)}.json`) {
        // 仍加载，便于兼容
      }
      store.set(parsed.id, parsed);
      count += 1;
    } catch {
      // 跳过损坏文件
    }
  }
  loaded = true;
  return count;
}

function ensureLoaded() {
  if (!loaded) {
    loadKnowledgeFromDisk();
  }
}

export function upsertKnowledge(input: {
  id?: string;
  resume: unknown;
  sourceText?: string;
  sourceFileName?: string;
}): KnowledgeEntry {
  ensureLoaded();
  const id = input.id?.trim() || randomUUID();
  // 校验 id 可落盘
  safeFileId(id);
  const prev = store.get(id);
  const resume = ResumeSchema.parse(input.resume);
  const entry: KnowledgeEntry = {
    id,
    resume,
    sourceText:
      input.sourceText !== undefined ? input.sourceText : prev?.sourceText,
    sourceFileName:
      input.sourceFileName !== undefined
        ? input.sourceFileName
        : prev?.sourceFileName,
    updatedAt: new Date().toISOString(),
  };
  store.set(id, entry);
  writeEntry(entry);
  return entry;
}

export function getKnowledge(id: string): KnowledgeEntry | null {
  ensureLoaded();
  const cached = store.get(id);
  if (cached) return cached;

  // 内存没有时再试读盘（兼容外部直接写文件）
  const path = entryPath(id);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseEntry(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed) return null;
    store.set(parsed.id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function listKnowledge(): Array<
  Pick<KnowledgeEntry, 'id' | 'updatedAt' | 'sourceFileName'> & { name: string }
> {
  ensureLoaded();
  return [...store.values()].map((e) => ({
    id: e.id,
    name: e.resume.name || e.resume.basicInfo?.name || '',
    sourceFileName: e.sourceFileName,
    updatedAt: e.updatedAt,
  }));
}

export function deleteKnowledge(id: string): boolean {
  ensureLoaded();
  const existed = store.delete(id);
  try {
    removeEntryFile(id);
  } catch {
    // 文件不存在也算删除成功（内存已删）
  }
  return existed || !existsSync(entryPath(id));
}

export function getKnowledgeDir(): string {
  return knowledgeDir();
}

export function formatKnowledgeForPrompt(entry: KnowledgeEntry): string {
  return JSON.stringify(
    {
      knowledgeId: entry.id,
      sourceFileName: entry.sourceFileName,
      updatedAt: entry.updatedAt,
      resume: entry.resume,
    },
    null,
    2,
  );
}
