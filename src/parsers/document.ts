import mammoth from 'mammoth';

export type SupportedDocKind = 'pdf' | 'docx' | 'txt' | 'md';

export function detectDocKind(fileName: string, mimeType?: string): SupportedDocKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') return 'pdf';
  if (
    lower.endsWith('.docx') ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (lower.endsWith('.txt') || mimeType === 'text/plain') return 'txt';
  if (lower.endsWith('.md') || mimeType === 'text/markdown') return 'md';
  if (lower.endsWith('.doc')) {
    throw new Error('暂不支持旧版 .doc，请另存为 .docx 或 PDF 后上传');
  }
  return null;
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
): Promise<{ text: string; kind: SupportedDocKind }> {
  const kind = detectDocKind(fileName, mimeType);
  if (!kind) {
    throw new Error(`不支持的文件类型: ${fileName}。请上传 PDF / DOCX / TXT`);
  }

  if (kind === 'txt' || kind === 'md') {
    return { text: buffer.toString('utf8'), kind };
  }

  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value?.trim() || '';
    if (!text) throw new Error('DOCX 未解析出有效文本');
    return { text, kind };
  }

  // pdf-parse v2
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    const text = parsed.text?.trim() || '';
    if (!text) throw new Error('PDF 未解析出有效文本（可能为扫描件，需 OCR）');
    return { text, kind };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
