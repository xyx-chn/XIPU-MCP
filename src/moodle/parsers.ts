import { load } from 'cheerio';
import { CORE, type Course, type Deadline, type Material, type Source } from '../shared.js';
import { createHash } from 'node:crypto';

export const stableId = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
export function schoolUrl(value: string, base = CORE): string | undefined {
  try { const u = new URL(value, base); return u.origin === CORE && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
export function parseCourses(html: string): Course[] {
  const $ = load(html); const result = new Map<string, Course>();
  $('a[href*="/course/view.php"]').each((_, element) => {
    const a = $(element); const url = schoolUrl(a.attr('href') ?? ''); if (!url) return;
    const id = new URL(url).searchParams.get('id'); if (!id || !/^\d+$/.test(id)) return;
    const name = a.find('.multiline, .coursename, .course-title').text().trim() || a.attr('title') || a.text().replace(/\s+/g, ' ').trim();
    if (!name) return; result.set(id, { id, name, shortName: name, url });
  }); return [...result.values()];
}
export type Activity = { id: string; courseId: string; name: string; section: string; url: string; type: string };
export function parseActivities(html: string, courseId: string): Activity[] {
  const $ = load(html); const result = new Map<string, Activity>();
  $('a[href*="/mod/"][href*="view.php"]').each((_, element) => {
    const a = $(element); const url = schoolUrl(a.attr('href') ?? ''); if (!url) return;
    const u = new URL(url), match = u.pathname.match(/^\/mod\/([a-z0-9_]+)\/view\.php$/); const id = u.searchParams.get('id'); if (!match || !id) return;
    const name = a.find('.instancename, .activityname').clone().children('.accesshide').remove().end().text().trim() || a.text().replace(/\s+/g, ' ').trim();
    const container=a.closest('.section, .course-section, .courseindex-section');
    const sectionContainer=container.length?container:a.closest('[data-sectionid], [data-section-id]');
    const heading=sectionContainer.find('.sectionname, .section-title, [data-for="section_title"]').first().clone();
    heading.find('button,input,svg,.accesshide,.sr-only,.visually-hidden,.icon,[aria-hidden="true"]').remove();
    const section = heading.text().replace(/\s+/g,' ').trim() || 'General';
    if(result.get(id)?.section!=='General'&&section==='General'&&result.has(id))return;
    result.set(id, { id, courseId, name, section, url, type: match[1] });
  }); return [...result.values()];
}
export function parseFiles(html: string, activity: Activity): Material[] {
  const $ = load(html); const files = new Map<string, Material>();
  $('a[href], object[data], iframe[src], embed[src]').each((_, element) => {
    const el = $(element); const raw = el.attr('href') ?? el.attr('data') ?? el.attr('src') ?? '';
    const url = schoolUrl(raw, activity.url); if (!url || !new URL(url).pathname.includes('/pluginfile.php/')) return;
    const u = new URL(url); u.searchParams.delete('forcedownload');
    let basename = u.pathname.split('/').pop() || 'material'; try { basename = decodeURIComponent(basename); } catch { /* keep encoded name */ }
    const id = stableId(activity.courseId, u.href);
    files.set(id, { id, courseId: activity.courseId, section: activity.section, name: basename, url: u.href, kind: 'file', activityUrl: activity.url });
  }); return [...files.values()];
}
export function parseExternalLinks(html: string, activity: Activity): Material[] {
  const $ = load(html); const result = new Map<string, Material>();
  $('.urlworkaround a[href], .resourceworkaround a[href], .activity-description a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? ''; let url: URL; try { url = new URL(raw, activity.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === CORE) return;
    const id = stableId(activity.courseId, url.href);
    result.set(id, { id, courseId: activity.courseId, section: activity.section, name: $(el).text().trim() || activity.name, url: url.href, kind: 'link', activityUrl: activity.url });
  }); return [...result.values()];
}
export function dateFromMoodle(value: string): string | undefined {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || /no due|not set|无|未设置/i.test(text)) return undefined;
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text)) { const n = Date.parse(text); return Number.isFinite(n) ? new Date(n).toISOString() : undefined; }
  let normalized = text.replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '').replace(/,/g, '');
  const zh = normalized.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日.*?(\d{1,2}):(\d{2})/);
  if (zh) normalized = `${zh[1]}-${zh[2].padStart(2,'0')}-${zh[3].padStart(2,'0')}T${zh[4].padStart(2,'0')}:${zh[5]}:00+08:00`;
  else if (!/(?:GMT|UTC|[+-]\d{4}|[+-]\d\d:\d\d|Z$)/i.test(normalized)) normalized += ' GMT+0800';
  const n = Date.parse(normalized); return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}
export function parseActivityDeadlines(html: string, activity: Activity): Deadline[] {
  const $ = load(html); const deadlines = new Map<Deadline['kind'], Deadline>(); let submissionStatus: string | undefined;
  const add = (label: string, value: string) => {
    let kind: Deadline['kind'] | undefined;
    if (/cut.off|截止提交|停止提交/i.test(label)) kind = 'assignment_cutoff';
    else if (/\bdue(?: date)?\b|到期|截止日期/i.test(label)) kind = activity.type === 'quiz' ? 'quiz_close' : 'assignment_due';
    else if (activity.type === 'quiz' && /close|关闭|结束/i.test(label)) kind = 'quiz_close';
    if (/submission status|提交状态/i.test(label)) submissionStatus = value.trim();
    const at = dateFromMoodle(value); if (!kind || !at) return;
    deadlines.set(kind, { id: stableId(activity.courseId, activity.id, kind), courseId: activity.courseId, name: activity.name, kind, at, timezone: 'Asia/Shanghai', url: activity.url, observedAt: new Date().toISOString(), source: 'moodle' });
  };
  $('tr').each((_, row) => {
    const r = $(row); const cells = r.find('th, td'); if (cells.length < 2) return;
    const value = cells.eq(1); add(cells.eq(0).text(), value.find('time[datetime]').attr('datetime') || value.text());
  });
  $('.activity-dates [data-region="activity-dates"], [data-region="activity-dates"] > div, .activity-dates > div').each((_, el) => {
    const e = $(el); const label = e.find('strong, b').first().text(); const t = e.find('time'); add(label, t.attr('datetime') || e.text().replace(label, '').trim());
  });
  // Current-user submission table dates take precedence over generic activity badges.
  $('.submissionstatustable tr').each((_, row) => { const c = $(row).find('th,td'); if (c.length > 1) add(c.eq(0).text(), c.eq(1).find('time').attr('datetime') || c.eq(1).text()); });
  return [...deadlines.values()].map(d => ({ ...d, submissionStatus }));
}
export function parseAnnouncementSources(html: string, courseId: string, base: string): Source[] {
  const $ = load(html); const result = new Map<string, Source>();
  $('a[href*="/mod/forum/discuss.php"]').each((_, el) => {
    const a = $(el); const url = schoolUrl(a.attr('href') ?? '', base); if (!url) return;
    const id = stableId('announcement', courseId, url); result.set(id, { id, courseId, name: a.text().trim() || 'Announcement', url, kind: 'announcement' });
  }); return [...result.values()];
}
export function extractWebText(html: string): string {
  const $ = load(html); $('script,style,nav,header,footer,.commands,.navbar,.activity-navigation').remove();
  const main = $('.forumpost .content, .post-content-container, .generalbox, #region-main').first();
  main.find('br').replaceWith('\n'); main.find('p,div,li,h1,h2,h3').append('\n');
  return (main.length ? main.text() : $('body').text()).replace(/[\t ]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
