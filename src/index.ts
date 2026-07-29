import cors from 'cors';
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runOptimizeProject } from './graphs/optimizeProject.js';
import { runOptimizeResume } from './graphs/optimizeResume.js';
import { runSummarizeProject } from './graphs/summarizeProject.js';

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

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/v1/summarize-project', async (req, res) => {
  try {
    const inputText = String(req.body?.inputText || '');
    if (!inputText.trim()) {
      res.status(400).json({ message: 'inputText 不能为空' });
      return;
    }
    const result = await runSummarizeProject(inputText);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/v1/optimize-project', async (req, res) => {
  try {
    const project = req.body?.project;
    if (!project) {
      res.status(400).json({ message: 'project 不能为空' });
      return;
    }
    const result = await runOptimizeProject(project, String(req.body?.instruction || ''));
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/v1/optimize-resume', async (req, res) => {
  try {
    const resume = req.body?.resume;
    if (!resume) {
      res.status(400).json({ message: 'resume 不能为空' });
      return;
    }
    const result = await runOptimizeResume(
      resume,
      String(req.body?.targetRole || ''),
      String(req.body?.instruction || ''),
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(port, () => {
  console.log(`[agent] listening on http://localhost:${port}`);
});
