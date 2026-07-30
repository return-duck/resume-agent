import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 从项目上一级目录读取 ../.env（相对 process.cwd） */
export function loadEnvFile(): string | null {
  const envPath = resolve(process.cwd(), '..', '.env');
  if (!existsSync(envPath)) return null;
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
  return envPath;
}
