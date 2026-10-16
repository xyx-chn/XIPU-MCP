import type { BrowserWindow } from 'electron';
import { CORE, SSO } from './shared.js';

export const LOGIN_RETRY_URL = 'xipu-login://retry';

type LoadReason = 'load_failed' | 'origin' | 'renderer' | 'closed' | 'aborted' | 'timeout';
class LoginLoadError extends Error {
  constructor(readonly reason: LoadReason, readonly errorCode?: number) {
    super('School login navigation did not complete');
    this.name = 'LoginLoadError';
  }
}

function numericLoadCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return;
  const value = error as { errorCode?: unknown; errno?: unknown; code?: unknown; message?: unknown };
  for (const code of [value.errorCode, value.errno, value.code]) {
    if (typeof code === 'number' && Number.isSafeInteger(code)) return code;
  }
  // Electron's loadURL rejection includes the numeric Chromium error in parentheses.
  // Extract only that number; never return its message, which may contain SSO tokens.
  if (typeof value.message === 'string') {
    const match = value.message.match(/\bERR_[A-Z_]+\s+\((-?\d+)\)/);
    if (match) {
      const code = Number(match[1]);
      if (Number.isSafeInteger(code)) return code;
    }
  }
}

function wasNavigationReplaced(error: unknown): boolean {
  return numericLoadCode(error) === -3 || !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ERR_ABORTED';
}

export function isLoginRedirectLoop(error: unknown): boolean { return numericLoadCode(error) === -310; }

function isSchoolPage(url: string): boolean {
  try {
    const target = new URL(url);
    return !target.username && !target.password && [CORE, SSO].includes(target.origin);
  } catch { return false; }
}

/** A cancelled loadURL may have been replaced by SSO navigation, rather than failed. */
export function loadSchoolLoginPage(win: BrowserWindow, url: string, signal: AbortSignal, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const contents = win.webContents;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('render-process-gone', crashed);
      win.removeListener('closed', closed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: LoginLoadError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const loaded = () => {
      if (win.isDestroyed() || contents.isDestroyed()) { finish(new LoginLoadError('closed')); return; }
      finish(isSchoolPage(contents.getURL()) ? undefined : new LoginLoadError('origin'));
    };
    const failed = (_event: unknown, code: number, _description: string, _url: string, mainFrame: boolean) => {
      // Subresources cannot decide whether the visible login document loaded.
      // -3 is also emitted when a legitimate navigation replaces the original one.
      if (mainFrame && code !== -3) finish(new LoginLoadError('load_failed', code));
    };
    const crashed = () => finish(new LoginLoadError('renderer'));
    const closed = () => finish(new LoginLoadError('closed'));
    const aborted = () => finish(new LoginLoadError('aborted'));

    if (signal.aborted) { aborted(); return; }
    if (win.isDestroyed() || contents.isDestroyed()) { closed(); return; }
    if (!isSchoolPage(url)) { finish(new LoginLoadError('origin')); return; }
    contents.on('did-finish-load', loaded);
    contents.on('did-fail-load', failed);
    contents.on('render-process-gone', crashed);
    win.on('closed', closed);
    signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new LoginLoadError('timeout')), timeoutMs);
    try {
      void win.loadURL(url).then(loaded, error => {
        if (!wasNavigationReplaced(error)) finish(new LoginLoadError('load_failed', numericLoadCode(error)));
      });
    } catch (error) {
      if (!wasNavigationReplaced(error)) finish(new LoginLoadError('load_failed', numericLoadCode(error)));
    }
  });
}

/** Return only fixed messages and a numeric code, never a remote error URL or body. */
export function loginLoadMessage(error: unknown): string {
  const reason = error && typeof error === 'object' ? (error as { reason?: unknown }).reason : undefined;
  if (reason === 'timeout') return '学校登录页面加载超时，请检查网络和代理后重新加载。';
  if (reason === 'origin') return '学校登录跳转到未允许的页面，已停止加载。请重新加载后重试。';
  if (reason === 'renderer') return '学校登录页面意外关闭，请重新加载。';
  if (reason === 'closed' || reason === 'aborted') return '学校登录已取消，请重新打开登录窗口。';
  const code = numericLoadCode(error);
  if(code===-310)return '学校登录会话发生循环跳转，请重新加载以重建本机学校会话。';
  return `学校登录页面加载失败${code === undefined ? '' : `（错误码 ${code}）`}，请检查网络和代理后重新加载。`;
}

export function loginFailureDocument(message: string): string {
  const safeMessage = message.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"><title>学校登录 · XIPU MCP</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:Canvas;color:CanvasText;font:16px/1.7 system-ui,-apple-system,sans-serif}main{width:100%;max-width:480px}h1{font-size:24px;line-height:1.4}p{opacity:.75;overflow-wrap:anywhere}a{display:inline-block;margin-top:16px;padding:10px 22px;border-radius:10px;background:#1478dd;color:white;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid Highlight;outline-offset:4px}</style></head><body><main><h1>学校登录页面未能加载</h1><p>${safeMessage}</p><a href="${LOGIN_RETRY_URL}">重新加载</a></main></body></html>`;
}
