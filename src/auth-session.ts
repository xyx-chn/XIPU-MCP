import type { Session } from 'electron';

const schoolCookieDomains = new Set(['core.xjtlu.edu.cn', 'uim.xjtlu.edu.cn', 'xjtlu.edu.cn']);

/** Reset only school login cookies in this private Electron session. */
export async function resetSchoolLoginCookies(session: Pick<Session, 'cookies'>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const cookies = await session.cookies.get({});
  signal.throwIfAborted();
  for (const cookie of cookies) {
    const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!schoolCookieDomains.has(domain)) continue;
    const target = new URL('https://' + domain);
    target.pathname = cookie.path || '/';
    signal.throwIfAborted();
    await session.cookies.remove(target.href, cookie.name);
    signal.throwIfAborted();
  }
}
