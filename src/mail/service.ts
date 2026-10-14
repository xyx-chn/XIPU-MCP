import { ImapFlow, type MessageStructureObject } from 'imapflow';
import { AppError, type MailSettings } from '../shared.js';
import { headerMatches, parseCode, validateMail } from './policy.js';
import { Pop3Client } from './pop3.js';

export type Baseline = { protocol: 'imap'; uidValidity: string; nextUid: number; since: number } | { protocol: 'pop3'; ids: string[]; since: number };
export interface OtpProvider {
  baseline(): Promise<Baseline>;
  waitForCode(baseline: Baseline, signal?: AbortSignal): Promise<string>;
}
export class MailService implements OtpProvider {
  constructor(private config: MailSettings, private password: string) {}
  private async imap<T>(callback: (client: ImapFlow) => Promise<T>) {
    validateMail(this.config, this.password);
    const client = new ImapFlow({ host: this.config.host, port: this.config.port, secure: this.config.security === 'tls', doSTARTTLS: this.config.security === 'starttls',
      auth: { user: this.config.username, pass: this.password }, logger: false, disableAutoIdle: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
    client.on('error', () => { /* connection errors are handled by the pending protocol operation */ });
    try { await client.connect(); await client.mailboxOpen(this.config.folder, { readOnly: true }); return await callback(client); }
    finally { try { await client.logout(); } catch { client.close(); } }
  }
  private async pop<T>(callback: (client: Pop3Client) => Promise<T>) {
    validateMail(this.config, this.password); const client = new Pop3Client(this.config, this.password);
    try { await client.connect(); return await callback(client); } finally { await client.close(); }
  }
  async test() {
    try {
      if (this.config.protocol === 'imap') await this.imap(async () => undefined);
      else await this.pop(async client => { await client.capabilities(); });
      return { ok: true, protocol: this.config.protocol, automaticOtp: true, message: 'TLS、认证及取码所需协议能力检查成功；未读取正文。' };
    } catch (error) {
      const code=(error as {code?:string})?.code;
      const labels:Record<string,string>={ECONNRESET:'连接被服务器或网络中断',ECONNREFUSED:'服务器拒绝连接',ENOTFOUND:'服务器域名无法解析',ETIMEDOUT:'连接超时',ETIMEOUT:'连接超时',EPIPE:'连接已关闭',ERR_TLS_CERT_ALTNAME_INVALID:'证书主机名不匹配',CERT_HAS_EXPIRED:'服务器证书已过期',DEPTH_ZERO_SELF_SIGNED_CERT:'服务器证书不受信任',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'无法验证服务器证书',AUTHENTICATIONFAILED:'邮箱认证失败',POP3_REJECTED:'POP3 服务器拒绝认证或协议请求',POP3_CAPABILITY:'POP3 缺少取码能力'};
      const detail=code&&labels[code]?labels[code]+'。':'';
      throw new AppError('MAIL_CONNECTION', detail+'邮箱连接或能力检查失败。请检查服务器、TLS、认证信息；POP3 需要 UIDL 和 TOP。未降级到明文连接。');
    }
  }
  async baseline(): Promise<Baseline> {
    if (this.config.protocol === 'imap') return this.imap(async client => {
      if (!client.mailbox) throw new Error('No mailbox');
      return { protocol: 'imap', uidValidity: String(client.mailbox.uidValidity), nextUid: client.mailbox.uidNext, since: Date.now() };
    });
    return this.pop(async client => ({ protocol: 'pop3', ids: [...(await client.capabilities()).keys()], since: Date.now() }));
  }
  private async scan(baseline: Baseline) {
    const candidates: Array<() => Promise<string>> = [];
    if (baseline.protocol === 'imap') return this.imap(async client => {
      if (!client.mailbox || String(client.mailbox.uidValidity) !== baseline.uidValidity) throw new AppError('MAIL_RESET', '邮箱 UID 已改变，请重新开始登录。');
      if (client.mailbox.uidNext <= baseline.nextUid) return undefined;
      const ids = await client.search({ uid: `${baseline.nextUid}:*`, since: new Date(baseline.since - 30_000) }, { uid: true });
      const safeIds = (ids || []).filter(x => x >= baseline.nextUid);
      if (safeIds.length > 100) throw new AppError('MAIL_VOLUME', '新增邮件过多，请手动输入验证码。');
      for (const uid of safeIds) {
        const message = await client.fetchOne(uid, { headers: ['from', 'to', 'cc', 'subject', 'date'], internalDate: true }, { uid: true });
        if (!message || !message.headers || !(await headerMatches(message.headers, this.config, baseline.since))) continue;
        candidates.push(async () => {
          const structure = await client.fetchOne(uid, { bodyStructure: true, size: true }, { uid: true });
          if (!structure || !structure.bodyStructure || (structure.size??0)>2*1024*1024) throw new AppError('MAIL_TOO_LARGE', '验证码邮件过大或结构不支持，请手动输入。');
          const parts: MessageStructureObject[]=[];
          const visit=(node:MessageStructureObject)=>{if(node.disposition==='attachment')return;if(['text/plain','text/html'].includes(node.type))parts.push(node);for(const child of node.childNodes??[])visit(child);};
          visit(structure.bodyStructure);const part=parts.find(p=>p.type==='text/plain')??parts[0];
          if(!part||(part.size??0)>256*1024)throw new AppError('OTP_FORMAT','验证码邮件没有可读取的短文本正文，请手动输入。');
          const partId=part.part??'TEXT';
          const result=await client.fetchOne(uid,{bodyParts:[{key:partId,maxLength:256*1024}]},{uid:true});
          const partKey=partId.toLowerCase();
          const bytes=result&&result.bodyParts?.get(partKey);if(!bytes)throw new AppError('OTP_FORMAT','无法读取验证码正文，请手动输入。');
          const encoding=result&&result.binaryParts?.has(partKey)?'8bit':part.encoding??'8bit';
          const mime=`Content-Type: ${part.type}; charset=${part.parameters?.charset??'utf-8'}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`;
          return parseCode(Buffer.concat([Buffer.from(mime),bytes]), this.config.codeLength);
        });
      }
      return this.only(candidates);
    });
    return this.pop(async client => {
      const ids = await client.uidl(); const old = new Set(baseline.ids); const added = [...ids].filter(([uid]) => !old.has(uid));
      if (added.length > 100) throw new AppError('MAIL_VOLUME', '新增邮件过多，请手动输入验证码。');
      for (const [, number] of added) if (await headerMatches(await client.headers(number), this.config, baseline.since))
        candidates.push(async () => parseCode(await client.message(number), this.config.codeLength));
      return this.only(candidates);
    });
  }
  private async only(candidates: Array<() => Promise<string>>) {
    if (candidates.length > 1) throw new AppError('OTP_AMBIGUOUS', '发现多封匹配验证码邮件，请手动输入。');
    return candidates.length === 1 ? candidates[0]() : undefined;
  }
  async waitForCode(baseline: Baseline, signal?: AbortSignal) {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      signal?.throwIfAborted(); const code = await this.scan(baseline); if (code) return code;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => { clearTimeout(timer); reject(new AppError('CANCELLED', '取码已取消。')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve(); }, 3000);
        signal?.addEventListener('abort', cancelled, { once: true });
      });
    }
    throw new AppError('OTP_TIMEOUT', '两分钟内未收到唯一匹配验证码，请在登录窗口手动输入。');
  }
}
