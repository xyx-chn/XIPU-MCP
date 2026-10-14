import { safeStorage } from 'electron';
import { mkdir, readFile, rename, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { atomicJson } from './files.js';
import { AppError, SettingsSchema, type Settings, type Secrets, type DownloadJob } from './shared.js';

export class Store {
  settings: Settings = SettingsSchema.parse({ downloadDirectory: path.join(homedir(), 'Downloads', 'XIPU MCP'), mail: {} });
  secrets: Secrets = {}; jobs: DownloadJob[] = [];
  constructor(readonly directory: string) {}
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    try { this.settings = SettingsSchema.parse(JSON.parse(await readFile(path.join(this.directory, 'settings.json'), 'utf8'))); } catch { /* first launch uses defaults */ }
    try {
      const encrypted = await readFile(path.join(this.directory, 'secrets.enc'));
      if (!safeStorage.isEncryptionAvailable()) throw new AppError('KEYCHAIN_UNAVAILABLE', '钥匙串暂不可用，请解锁后重新启动。');
      this.secrets = JSON.parse(safeStorage.decryptString(encrypted));
    } catch (e: any) { if (e?.code !== 'ENOENT') throw new AppError('KEYCHAIN_UNAVAILABLE', '无法解密已保存凭据，请检查钥匙串或清除凭据后重新配置。'); }
    try { this.jobs = JSON.parse(await readFile(path.join(this.directory, 'jobs.json'), 'utf8')); } catch { /* no jobs */ }
    for (const job of this.jobs) if (job.state === 'running') {
      job.state = 'completed'; for (const item of job.items) if (['pending','downloading'].includes(item.state)) { item.state = 'failed'; item.error = 'App 已退出，下载未完成；可重试失败项。'; }
    }
  }
  async saveSettings(settings: Settings) { this.settings = settings; await atomicJson(path.join(this.directory, 'settings.json'), settings); }
  async saveSecrets() {
    if (!safeStorage.isEncryptionAvailable()) throw new AppError('KEYCHAIN_UNAVAILABLE', '钥匙串不可用，无法保存凭据。');
    const file = path.join(this.directory,'secrets.enc'), temp = file + '.tmp';
    await writeFile(temp, safeStorage.encryptString(JSON.stringify(this.secrets)), { mode: 0o600 }); await rename(temp,file);
  }
  async saveJobs() { await atomicJson(path.join(this.directory,'jobs.json'),this.jobs); }
  async clearSecrets() { this.secrets = {}; await rm(path.join(this.directory,'secrets.enc'), { force:true }); }
}
