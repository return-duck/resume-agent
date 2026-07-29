import { z } from 'zod';

/** 与 resume-server Dtos 对齐的共享 Zod schema */

export const EducationSchema = z.object({
  school: z.string().default(''),
  degree: z.string().default(''),
  date: z.string().default(''),
});

export const ProjectWorkSchema = z.object({
  label: z.string().default(''),
  text: z.string().default(''),
});

export const SkillItemSchema = z.object({
  label: z.string(),
  content: z.string(),
});

export const BasicInfoSchema = z.object({
  id: z.string().optional(),
  name: z.string().default(''),
  phone: z.string().default(''),
  email: z.string().default(''),
  age: z.number().optional().nullable(),
  educations: z.array(EducationSchema).default([]),
});

export const ProjectSchema = z.object({
  id: z.string().optional(),
  companyId: z.string().optional(),
  org: z.string().default(''),
  name: z.string(),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
  description: z.string().default(''),
  responsibilities: z.array(ProjectWorkSchema).default([]),
  achievements: z.array(ProjectWorkSchema).default([]),
  sortOrder: z.number().optional(),
});

export const CompanySchema = z.object({
  id: z.string().optional(),
  name: z.string().default(''),
  roleTitle: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
  sortOrder: z.number().optional(),
  projects: z.array(ProjectSchema).default([]),
});

export const SkillDtoSchema = z.object({
  id: z.string().optional(),
  direction: z.string().optional(),
  description: z.string().optional(),
  label: z.string().optional(),
  content: z.string().optional(),
  sortOrder: z.number().optional(),
});

export const ProjectRefSchema = z.object({
  projectId: z.string(),
  sortOrder: z.number().default(0),
});

/** resume-server 可读懂的完整简历结构（Knowledge 载体） */
export const ResumeSchema = z.object({
  id: z.string().optional(),
  basicInfoId: z.string().optional(),
  name: z.string().default(''),
  title: z.string().default(''),
  variant: z.string().default(''),
  basicInfo: BasicInfoSchema.optional(),
  skills: z.array(SkillDtoSchema).default([]),
  companies: z.array(CompanySchema).default([]),
  projectRefs: z.array(ProjectRefSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
});

export type Education = z.infer<typeof EducationSchema>;
export type ProjectWork = z.infer<typeof ProjectWorkSchema>;
export type SkillItem = z.infer<typeof SkillItemSchema>;
export type BasicInfo = z.infer<typeof BasicInfoSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Company = z.infer<typeof CompanySchema>;
export type Resume = z.infer<typeof ResumeSchema>;

export const OptimizeResumeResultSchema = z.object({
  basicInfo: BasicInfoSchema.optional(),
  educations: z.array(EducationSchema).optional(),
  skills: z.array(SkillItemSchema).optional(),
  projectSuggestions: z
    .array(
      z.object({
        projectId: z.string(),
        project: ProjectSchema,
      }),
    )
    .default([]),
});

export type OptimizeResumeResult = z.infer<typeof OptimizeResumeResultSchema>;
