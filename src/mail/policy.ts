import { simpleParser, type ParsedMail } from 'mailparser';
import { AppError, type MailSettings } from '../shared.js';

export function matchesHeaders(mail: ParsedMail, settings: MailSettings, since: number): boolean {
  const from = mail.from?.value ?? [];
  if (from.length !== 1 || !from[0].address) return false;
  const address = from[0].address.toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const allowed = settings.senders.map(x => x.toLowerCase()).includes(address) || settings.senderDomains.some(x => {
    const d = x.toLowerCase().trim(); return d !== '' && (domain === d || domain.endsWith('.' + d));
  });
  const recipients = [mail.to, mail.cc].flatMap(x => !x ? [] : Array.isArray(x) ? x.flatMap(y => y.value) : x.value);
  const recipient = settings.recipient.toLowerCase();
  return allowed && recipient !== '' && recipients.some(x => x.address?.toLowerCase() === recipient)
    && settings.subjectPatterns.some(x => x.trim() !== '' && (mail.subject ?? '').toLowerCase().includes(x.toLowerCase()))
    && !!mail.date && mail.date.getTime() >= since - 30_000 && mail.date.getTime() <= Date.now() + 60_000;
}

export function extractCode(text: string, length: number): string {
  const codes = [...new Set([...text.matchAll(new RegExp('(?<![0-9])([0-9]{' + length + '})(?![0-9])', 'g'))].map(x => x[1]))];
  if (codes.length !== 1) throw new AppError('OTP_AMBIGUOUS', '验证码邮件无法唯一识别，请在登录窗口手动输入。');
  return codes[0];
}

export async function headerMatches(raw: Buffer | string, settings: MailSettings, since: number) {
  return matchesHeaders(await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true }), settings, since);
}
export async function parseCode(raw: Buffer | string, length: number) {
  const mail = await simpleParser(raw, { skipTextToHtml: true });
  return extractCode(mail.text ?? '', length);
}
export function validateMail(settings: MailSettings, password?: string) {
  if (!settings.host || /[\s/\\\x00-\x1f]/.test(settings.host) || !settings.username || !password || !settings.recipient.includes('@'))
    throw new AppError('MAIL_CONFIG', '请填写邮箱服务器、用户名、密码／授权码和收码地址。');
  if (!(settings.senders.length || settings.senderDomains.length) || !settings.subjectPatterns.some(x => x.trim()))
    throw new AppError('MAIL_POLICY', '请配置验证码发件人／域名及主题特征。');
}
