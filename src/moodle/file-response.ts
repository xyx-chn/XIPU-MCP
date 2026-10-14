import { CORE, type Material } from '../shared.js';
import { schoolUrl, stableId, type Activity } from './parsers.js';

const extensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt', 'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls', 'application/zip': '.zip',
  'text/plain': '.txt', 'text/csv': '.csv',
};

function filename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Treat both POSIX and Windows separators as paths, even on macOS.
  const name = value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name : undefined;
}

function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = header.match(/(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  if (extended) {
    const value = (extended[1] ?? extended[2]).trim();
    const encoded = value.match(/^utf-8'[^']*'(.*)$/i);
    if (encoded) {
      try { const name = filename(decodeURIComponent(encoded[1])); if (name) return name; }
      catch { /* A malformed extended filename can fall back to the ordinary one. */ }
    }
  }
  const ordinary = header.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i);
  if(!ordinary)return undefined;
  let value=(ordinary[1]?.replace(/\\(.)/g,'$1')??ordinary[2]).trim();
  // Chromium can expose raw UTF-8 header bytes as Latin-1. Recover only valid UTF-8;
  // a genuinely Latin-1 filename must retain its original characters.
  if(/[\x80-\xff]/.test(value)&&![...value].some(c=>c.charCodeAt(0)>255)) {
    try{value=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(value,c=>c.charCodeAt(0)));}catch{/* Keep the original Latin-1 value. */}
  }
  return filename(value);
}

function normalizedUrl(value: string): URL | undefined {
  const safe = schoolUrl(value); if (!safe) return undefined;
  const url = new URL(safe); url.searchParams.delete('forcedownload');
  return url;
}

/** Discover a Moodle resource served as a file rather than an HTML wrapper. */
export function materialFromFileResponse(activity: Activity, finalUrl: string, headers: Headers): Material | undefined {
  const url = normalizedUrl(finalUrl); if (!url || url.origin !== CORE) return undefined;
  const pluginfile = /^\/pluginfile\.php\/\d+\/[^/]+\/[^/]+\/.+/.test(url.pathname);
  const knownActivityUrl = normalizedUrl(activity.url);
  const directResource = activity.type === 'resource' && url.pathname === '/mod/resource/view.php'
    && knownActivityUrl?.pathname === url.pathname && url.href === knownActivityUrl.href
    && url.searchParams.get('id') === activity.id;
  if (!pluginfile && !directResource) return undefined;

  const mime = headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mime && (['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'].includes(mime) || /^(?:video|audio)\//.test(mime))) return undefined;
  const disposition = headers.get('content-disposition');
  let pathName: string | undefined;
  if (pluginfile) {
    const basename = url.pathname.split('/').at(-1);
    try { pathName = filename(basename && decodeURIComponent(basename)); }
    catch { pathName = filename(basename); }
  }
  let name = dispositionFilename(disposition) ?? pathName ?? filename(activity.name);
  if (!name || /\.(?:html?|xhtml|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg)$/i.test(name)) return undefined;
  // Header-less HTML responses must be parsed and checked by the HTML adapter.
  if (!mime && !/^(?:attachment)\s*(?:;|$)/i.test(disposition ?? '')) return undefined;
  if (!/\.[^. ]{1,12}$/.test(name) && mime && extensions[mime]) name += extensions[mime];

  const length = headers.get('content-length');
  const parsedSize = length && /^\d+$/.test(length) ? Number(length) : undefined;
  const encoding = headers.get('content-encoding');
  const size = parsedSize !== undefined && Number.isSafeInteger(parsedSize) && (!encoding || encoding.toLowerCase() === 'identity') ? parsedSize : undefined;
  const modified = Date.parse(headers.get('last-modified') ?? '');
  return {
    id: stableId(activity.courseId, url.href), courseId: activity.courseId,
    section: activity.section, name, url: url.href, kind: 'file', activityUrl: activity.url,
    ...(mime ? { mime } : {}), ...(size !== undefined ? { size } : {}),
    ...(Number.isFinite(modified) ? { modified } : {}),
  };
}
