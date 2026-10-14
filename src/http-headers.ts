import { AppError } from './shared.js';

/** Convert Chromium header strings into the byte strings required by WHATWG Headers. */
export function responseHeaders(raw: Record<string, string | string[] | undefined>, baseUrl: string): Headers {
  try {
    const headers = new Headers();
    for (const [key, entries] of Object.entries(raw)) {
      if (entries === undefined) continue;
      for (let value of Array.isArray(entries) ? entries : [entries]) {
        if (/[\r\n\u0000]/.test(value)) throw new Error('Invalid header value');
        if (key.toLowerCase() === 'location') value = new URL(value, baseUrl).href;
        else if (/[\u0100-\uffff]/.test(value)) value = Buffer.from(value, 'utf8').toString('latin1');
        headers.append(key, value);
      }
    }
    return headers;
  } catch {
    throw new AppError('MOODLE_HEADERS', '学校返回无效响应头，请重试。');
  }
}
