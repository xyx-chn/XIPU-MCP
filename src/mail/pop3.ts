import tls, { type TLSSocket } from 'node:tls';
import net, { type Socket } from 'node:net';
import { AppError, type MailSettings } from '../shared.js';

type Connection = Socket | TLSSocket;
/** Bounded POP3 wire client. No delete command is implemented. */
export class Pop3Client {
  private socket?: Connection;
  private buffer = Buffer.alloc(0);
  private wake?: () => void;
  private failure?: Error;
  private handlers = {
    data: (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 6 * 1024 * 1024) this.failure = new Error('POP3 response exceeds limit');
      this.wake?.();
    },
    error: (e: Error) => { this.failure = e; this.wake?.(); },
    close: () => { this.failure ??= new Error('POP3 connection closed'); this.wake?.(); },
  };
  constructor(private config: MailSettings, private password: string) {}
  private attach(socket: Connection) {
    this.socket = socket;
    socket.on('data', this.handlers.data); socket.on('error', this.handlers.error); socket.on('close', this.handlers.close);
    socket.setTimeout(15_000, () => socket.destroy(new Error('POP3 timeout')));
  }
  private detach() {
    this.socket?.off('data', this.handlers.data); this.socket?.off('error', this.handlers.error); this.socket?.off('close', this.handlers.close);
  }
  async connect() {
    if (this.config.security === 'tls') {
      const socket = tls.connect({ host: this.config.host, port: this.config.port, servername: net.isIP(this.config.host) ? undefined : this.config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      this.attach(socket); await this.secure(socket);
    } else {
      this.attach(net.connect({ host: this.config.host, port: this.config.port }));
    }
    this.positive(await this.line());
    if (this.config.security === 'starttls') {
      await this.command('STLS');
      this.detach();
      const socket = tls.connect({ socket: this.socket!, servername: net.isIP(this.config.host) ? undefined : this.config.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      this.attach(socket); await this.secure(socket);
    }
    await this.command('USER ' + this.safe(this.config.username));
    await this.command('PASS ' + this.safe(this.password));
  }
  private secure(socket: TLSSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('TLS timeout')); }, 15_000);
      const cleanup = () => { clearTimeout(timer); socket.off('error', fail); socket.off('secureConnect', done); };
      const fail = (e: Error) => { cleanup(); reject(e); };
      const done = () => { cleanup(); resolve(); };
      socket.once('secureConnect', done); socket.once('error', fail);
    });
  }
  private safe(value: string) { if (/[\r\n\x00]/.test(value)) throw new AppError('MAIL_CONFIG', '邮箱配置包含无效字符。'); return value; }
  private positive(line: string) { if (!line.startsWith('+OK')) throw new AppError('POP3_REJECTED', 'POP3 服务器拒绝请求，请检查认证或协议能力。'); }
  private async line(): Promise<string> {
    while (true) {
      if (this.failure) throw this.failure;
      const index = this.buffer.indexOf('\r\n');
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString('utf8'); this.buffer = this.buffer.subarray(index + 2); return line;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.wake = undefined; reject(new Error('POP3 read timeout')); }, 15_000);
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
  }
  async command(command: string, multiline = false): Promise<string> {
    if (!/^(STLS|USER |PASS |CAPA$|UIDL$|TOP \d+ 0$|RETR \d+$|LIST \d+$|QUIT$)/.test(command)) throw new Error('Unsupported POP3 command');
    this.socket!.write(command + '\r\n'); const first = await this.line(); this.positive(first);
    if (!multiline) return first;
    const lines: string[] = []; let bytes = 0;
    while (true) {
      const line = await this.line(); if (line === '.') break;
      bytes += Buffer.byteLength(line) + 2; if (bytes > 5 * 1024 * 1024) throw new AppError('MAIL_TOO_LARGE', '验证码邮件过大，请手动输入。');
      lines.push(line.startsWith('..') ? line.slice(1) : line);
    }
    return lines.join('\r\n');
  }
  async uidl(): Promise<Map<string, number>> {
    const response = await this.command('UIDL', true);
    return new Map(response.split('\r\n').filter(Boolean).map(line => {
      const [number, uid] = line.split(/\s+/); if (!uid || !/^\d+$/.test(number)) throw new Error('Invalid UIDL'); return [uid, Number(number)];
    }));
  }
  async capabilities() {
    let caps = '';
    try { caps = await this.command('CAPA', true); } catch { /* Older servers may omit CAPA; UIDL/TOP are probed. */ }
    const ids = await this.uidl();
    const first = ids.values().next().value as number | undefined;
    if (first !== undefined) await this.command(`TOP ${first} 0`, true);
    else if (!/^TOP(?:\s|$)/im.test(caps)) throw new AppError('POP3_CAPABILITY', '无法确认 POP3 TOP 能力，请改用 IMAP 或人工输入。');
    return ids;
  }
  async headers(number: number) { return this.command(`TOP ${number} 0`, true); }
  async message(number: number) {
    const size = await this.command(`LIST ${number}`);
    const bytes = Number(size.split(/\s+/)[2]);
    if (!Number.isFinite(bytes) || bytes > 2 * 1024 * 1024) throw new AppError('MAIL_TOO_LARGE', '验证码邮件过大，请手动输入。');
    return this.command(`RETR ${number}`, true);
  }
  async close() { try { if (this.socket && !this.failure) await this.command('QUIT'); } catch { /* no deletion was requested */ } finally { this.socket?.destroy(); } }
}
