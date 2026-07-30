import type { BasicInfo, Company, Education, Project, Resume } from '../schemas/resume.js';
import { ResumeSchema } from '../schemas/resume.js';

const SECTION_HEADERS =
  /^(?:个人信[息息]|基本信息|教育经历|教育背景|学历|工作经历|工作经验|项目经历|项目经验|专业技能|技能|自我评价|获奖|证书|实习经历)\s*$/u;

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function extractEmail(text: string): string {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m?.[0] || '';
}

function extractPhone(text: string): string {
  const m = text.match(
    /(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})/,
  );
  return m?.[0]?.replace(/\s+/g, '') || '';
}

function extractAge(text: string): number | null {
  const m = text.match(/(?:年龄|age)[:：\s]*(\d{1,2})/i);
  if (m) return Number(m[1]);
  const y = text.match(/(\d{2})\s*岁/);
  if (y) return Number(y[1]);
  return null;
}

function guessName(lines: string[], email: string, phone: string): string {
  for (const line of lines.slice(0, 8)) {
    if (SECTION_HEADERS.test(line)) continue;
    if (email && line.includes(email)) continue;
    if (phone && line.includes(phone)) continue;
    if (/[@：:]/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (line.length >= 2 && line.length <= 16 && !/项目|公司|大学|学院/.test(line)) {
      return line.replace(/姓名[:：]\s*/g, '').trim();
    }
  }
  return '';
}

type SectionMap = Record<string, string[]>;

function splitSections(lines: string[]): SectionMap {
  const map: SectionMap = { _preamble: [] };
  let current = '_preamble';
  for (const line of lines) {
    const key = classifyHeader(line);
    if (key) {
      current = key;
      if (!map[current]) map[current] = [];
      continue;
    }
    if (!map[current]) map[current] = [];
    map[current].push(line);
  }
  return map;
}

function classifyHeader(line: string): string | null {
  const t = line.replace(/[：:]\s*$/, '').trim();
  if (/教育|学历|院校/.test(t)) return 'education';
  if (/专业技能|技能专长|^技能$|技术栈/.test(t)) return 'skills';
  if (/项目经历|项目经验|^项目$|代表性项目/.test(t)) return 'projects';
  if (/工作经历|工作经验|任职|职业经历|实习/.test(t)) return 'work';
  if (/个人信|基本信息|联系方式/.test(t)) return 'basic';
  if (/自我评价|个人评价|总结/.test(t)) return 'summary';
  return null;
}

function parseEducations(lines: string[]): Education[] {
  const educations: Education[] = [];
  const dateRe = /(\d{4}[.\/年-]\d{0,2})\s*[-~—至到]+\s*(\d{4}[.\/年-]\d{0,2}|至今|present)/i;
  for (const line of lines) {
    const dateM = line.match(dateRe);
    const schoolM = line.match(/([\u4e00-\u9fa5A-Za-z0-9·]{2,40}?(?:大学|学院|学校|University|College))/);
    if (!schoolM && !dateM) continue;
    educations.push({
      school: schoolM?.[1] || line.slice(0, 40),
      degree: /博士/.test(line)
        ? '博士'
        : /硕士|研究生/.test(line)
          ? '硕士'
          : /本科|学士/.test(line)
            ? '本科'
            : /大专|专科/.test(line)
              ? '大专'
              : '',
      date: dateM ? `${dateM[1]}-${dateM[2]}`.replace(/年/g, '.').replace(/月/g, '') : '',
    });
  }
  return educations;
}

function parseSkills(lines: string[]): Resume['skills'] {
  const skills: Resume['skills'] = [];
  for (const line of lines) {
    const parts = line.split(/[:：]/);
    if (parts.length >= 2 && parts[0].length <= 20) {
      const label = parts[0].trim();
      const content = parts.slice(1).join(':').trim();
      if (label && content) {
        skills.push({
          label,
          content,
          direction: label,
          description: content,
        });
        continue;
      }
    }
    // 逗号/顿号列举
    if (/[,，、|/]/.test(line) && line.length < 200) {
      skills.push({
        label: '技能',
        content: line,
        direction: '技能',
        description: line,
      });
    } else if (line.length > 2) {
      skills.push({
        label: '其他',
        content: line,
        direction: '其他',
        description: line,
      });
    }
  }
  return skills;
}

function parseDateRange(text: string): { startDate: string; endDate: string } {
  const m = text.match(
    /(\d{4}[.\/年-]\d{0,2})\s*[-~—至到]+\s*(\d{4}[.\/年-]\d{0,2}|至今|present|今)/i,
  );
  if (!m) return { startDate: '', endDate: '' };
  const norm = (s: string) =>
    /至今|present|^今$/i.test(s) ? 'present' : s.replace(/年/g, '.').replace(/月/g, '');
  return { startDate: norm(m[1]), endDate: norm(m[2]) };
}

function parseProjects(lines: string[]): Project[] {
  const projects: Project[] = [];
  let current: Project | null = null;

  const flush = () => {
    if (current && (current.name || current.description)) {
      projects.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const dates = parseDateRange(line);
    const looksTitle =
      (dates.startDate || /^[\d一二三四五六七八九]|项目|系统|平台|官网/.test(line)) &&
      line.length < 80;

    if (looksTitle && (!current || current.responsibilities.length + current.achievements.length > 0)) {
      flush();
      current = {
        name: line.replace(dates.startDate && dates.endDate ? /[\d.\/年-]+.*$/ : '', '').trim() || line,
        org: '',
        startDate: dates.startDate,
        endDate: dates.endDate,
        description: '',
        responsibilities: [],
        achievements: [],
      };
      continue;
    }

    if (!current) {
      current = {
        name: line.slice(0, 40),
        org: '',
        startDate: '',
        endDate: '',
        description: '',
        responsibilities: [],
        achievements: [],
      };
    }

    if (/^[\-•·*、]/.test(line) || /负责|参与|完成|实现|优化|主导/.test(line)) {
      const text = line.replace(/^[\-•·*\d、.\s]+/, '');
      if (/成果|提升|增长|指标|收益|上线/.test(text)) {
        current.achievements.push({ label: '成果', text });
      } else {
        current.responsibilities.push({ label: '职责', text });
      }
    } else if (!current.description) {
      current.description = line;
    } else if (/公司|科技|集团|有限/.test(line) && !current.org) {
      current.org = line;
    } else {
      current.responsibilities.push({ label: '说明', text: line });
    }
  }
  flush();
  return projects;
}

function parseCompaniesFromWork(lines: string[], projects: Project[]): Company[] {
  const companies: Company[] = [];
  let current: Company | null = null;
  for (const line of lines) {
    const dates = parseDateRange(line);
    if (/公司|科技|集团|银行|有限|Inc|Ltd|Corp/i.test(line) || (dates.startDate && line.length < 60)) {
      if (current) companies.push(current);
      current = {
        name: line.replace(/\d{4}.*/, '').trim() || line,
        roleTitle: '',
        startDate: dates.startDate,
        endDate: dates.endDate,
        projects: [],
      };
      continue;
    }
    if (current && /工程师|经理|总监|开发|架构|实习生|顾问/.test(line) && !current.roleTitle) {
      current.roleTitle = line;
    }
  }
  if (current) companies.push(current);

  // 将无 org 的项目挂到第一家公司
  if (companies.length && projects.length) {
    for (const p of projects) {
      if (!p.org) p.org = companies[0].name;
    }
    companies[0].projects = [...projects];
  }
  return companies;
}

function emptyResume(): Resume {
  return ResumeSchema.parse({
    name: '',
    title: '',
    variant: '',
    basicInfo: {
      name: '',
      phone: '',
      email: '',
      age: null,
      educations: [],
    },
    skills: [],
    companies: [],
    projectRefs: [],
    projects: [],
  });
}

/**
 * 步骤1：纯代码规则尽量填充 Resume JSON 草稿。
 */
export function extractResumeDraft(rawText: string, seed?: Resume | null): {
  draft: Resume;
  sections: SectionMap;
  sourceText: string;
} {
  const text = (rawText || '').trim();
  const lines = splitLines(text);
  const sections = splitSections(lines);

  const email = extractEmail(text);
  const phone = extractPhone(text);
  const age = extractAge(text);
  const name = guessName(lines, email, phone);

  const educations = parseEducations(sections.education || []);
  const skills = parseSkills(sections.skills || []);
  const projects = parseProjects(sections.projects || sections.work || []);
  const companies = parseCompaniesFromWork(sections.work || [], projects);

  let draft = emptyResume();
  draft.name = name ? `${name}的简历` : '未命名简历';
  draft.title = '';
  draft.basicInfo = {
    name,
    phone,
    email,
    age,
    educations,
  };
  draft.skills = skills;
  draft.projects = projects;
  draft.companies = companies;
  draft.projectRefs = projects
    .map((p, i) => (p.id ? { projectId: p.id, sortOrder: i } : null))
    .filter(Boolean) as Resume['projectRefs'];

  if (seed) {
    draft = mergeResumePreferFilled(seed, draft);
  }

  draft = ResumeSchema.parse(draft);
  return { draft, sections, sourceText: text };
}

/** seed 优先保留已有非空字段，draft 补空 */
function mergeResumePreferFilled(seed: Resume, draft: Resume): Resume {
  const pick = (a: string, b: string) => (a && a.trim() ? a : b);
  const basic: BasicInfo = {
    id: seed.basicInfo?.id,
    name: pick(seed.basicInfo?.name || '', draft.basicInfo?.name || ''),
    phone: pick(seed.basicInfo?.phone || '', draft.basicInfo?.phone || ''),
    email: pick(seed.basicInfo?.email || '', draft.basicInfo?.email || ''),
    age: seed.basicInfo?.age ?? draft.basicInfo?.age ?? null,
    educations:
      seed.basicInfo?.educations?.length
        ? seed.basicInfo.educations
        : draft.basicInfo?.educations || [],
  };
  return ResumeSchema.parse({
    ...draft,
    ...seed,
    name: pick(seed.name, draft.name),
    title: pick(seed.title, draft.title),
    basicInfo: basic,
    skills: seed.skills?.length ? seed.skills : draft.skills,
    projects: seed.projects?.length ? seed.projects : draft.projects,
    companies: seed.companies?.length ? seed.companies : draft.companies,
    projectRefs: seed.projectRefs?.length ? seed.projectRefs : draft.projectRefs,
  });
}

export function sectionText(
  sections: SectionMap,
  keys: string[],
  fallbackSource: string,
  max = 8000,
): string {
  const chunks: string[] = [];
  for (const k of keys) {
    if (sections[k]?.length) chunks.push(sections[k].join('\n'));
  }
  const text = chunks.join('\n').trim() || fallbackSource;
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}
