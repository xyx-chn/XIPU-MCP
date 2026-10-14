import { z } from 'zod';

export const CORE = 'https://core.xjtlu.edu.cn';
export const SSO = 'https://uim.xjtlu.edu.cn';
export const MailConfig = z.object({
  enabled: z.boolean().default(false), protocol: z.enum(['imap', 'pop3']).default('imap'),
  host: z.string().default(''), port: z.number().int().min(1).max(65535).default(993),
  security: z.enum(['tls', 'starttls']).default('tls'), username: z.string().default(''),
  recipient: z.string().default(''), folder: z.string().default('INBOX'),
  senders: z.array(z.string()).default([]), senderDomains: z.array(z.string()).default(['xjtlu.edu.cn']),
  subjectPatterns: z.array(z.string()).default(['verification', 'verify', '验证码', '认证码', 'security code']),
  codeLength: z.number().int().min(4).max(8).default(6),
});
export type MailSettings = z.infer<typeof MailConfig>;
export const SettingsSchema = z.object({
  username: z.string().default(''), downloadDirectory: z.string().min(1), mail: MailConfig,
});
export type Settings = z.infer<typeof SettingsSchema>;
export type Secrets = { schoolPassword?: string; mailPassword?: string; cookies?: Electron.Cookie[] };
export type AuthStatus = { state: 'unconfigured' | 'signed_out' | 'connecting' | 'needs_user' | 'authenticated'; message: string; checkedAt: string; diagnostic?: {stage:string;httpStatus?:number;pageTitle?:string} };
export type Course = { id: string; name: string; shortName: string; url: string };
export type Material = { id: string; courseId: string; section: string; name: string; url: string; kind: 'file' | 'link'; mime?: string; size?: number; modified?: number; activityUrl: string };
export type Deadline = { id: string; courseId: string; name: string; kind: 'assignment_due' | 'assignment_cutoff' | 'quiz_close' | 'calendar'; at: string; timezone: 'Asia/Shanghai'; submissionStatus?: string; url: string; observedAt: string; source: 'moodle' };
export type Source = { id: string; courseId: string; name: string; url: string; kind: 'material' | 'announcement'; materialId?: string };
export type TextSection = { location: string; text: string };
export type JobItem = { materialId: string; name: string; state: 'pending' | 'downloading' | 'completed' | 'skipped' | 'failed' | 'cancelled'; path?: string; bytes?: number; error?: string };
export type DownloadJob = { id: string; state: 'running' | 'completed' | 'cancelled'; createdAt: string; items: JobItem[] };
export class AppError extends Error { constructor(public code: string, message: string) { super(message); } }
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof AppError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: '操作失败，请查看 App 中的连接诊断。' };
}
export const toolSchemas = {
  auth_status: z.object({}), list_courses: z.object({}),
  list_materials: z.object({ courseIds: z.array(z.string()).min(1).max(50) }),
  download_materials: z.object({ materialIds: z.array(z.string()).min(1).max(500), retryJobId: z.string().optional() }),
  get_download_job: z.object({ jobId: z.string() }), cancel_download_job: z.object({ jobId: z.string() }),
  list_deadlines: z.object({ courseIds: z.array(z.string()).max(50).optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }),
  list_deadline_sources: z.object({ courseIds: z.array(z.string()).min(1).max(50) }),
  read_deadline_source: z.object({ sourceId: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20000).default(12000) }),
};
export type ToolName = keyof typeof toolSchemas;
