import { load } from 'cheerio';
import { AppError, CORE, SSO, type Course, type Deadline, type Material, type Source } from '../shared.js';
import { parseActivities, parseActivityDeadlines, parseAnnouncementSources, parseCourses, parseExternalLinks, parseFiles, schoolUrl, stableId } from './parsers.js';
import { materialFromFileResponse } from './file-response.js';

export interface SchoolTransport { fetch(url: string, init?: RequestInit): Promise<Response>; }
export class MoodleClient {
  courses = new Map<string, Course>(); materials = new Map<string, Material>(); sources = new Map<string, Source>();
  private indexGeneration = 0;
  constructor(private transport: SchoolTransport, private ensureAuth: () => Promise<void>) {}
  private assertIndexGeneration(generation: number) {
    if (generation !== this.indexGeneration) throw new AppError('AUTH_REQUIRED', '账户或课程索引已更新，请重新查询。');
  }
  async resolvedResponse(url: string, init?: RequestInit, externalLinkMetadata=false) {
    const generation = this.indexGeneration;
    if (!schoolUrl(url)) throw new AppError('URL_DENIED', '只允许访问学校 Moodle 来源。');
    let current = url;
    for (let redirects = 0; redirects < 6; redirects++) {
      const response = await this.transport.fetch(current, { ...init, redirect: 'manual' });
      if (generation !== this.indexGeneration) {
        try { await response.body?.cancel(); } catch { /* Already-consumed bodies still reject stale requests. */ }
        this.assertIndexGeneration(generation);
      }
      if ([301,302,303,307,308].includes(response.status)) {
        const next = response.headers.get('location'); const safe = next && schoolUrl(next, current);
        await response.body?.cancel();
        this.assertIndexGeneration(generation);
        if(next&&!safe&&externalLinkMetadata) {
          let target:URL|undefined;try{target=new URL(next,current);}catch{/* reject invalid destinations */}
          if(target&&['https:','http:'].includes(target.protocol)&&!target.username&&!target.password&&target.origin!==SSO)return{response,url:target.href,external:true};
        }
        if (!safe || new URL(safe).pathname.startsWith('/auth/')) throw new AppError('AUTH_REQUIRED', '学校会话已失效，请重新登录。');
        current = safe; continue;
      }
      if ([401,403].includes(response.status)) throw new AppError('AUTH_REQUIRED', '学校会话失效或无权访问，请在 App 检查登录。');
      if (!response.ok) throw new AppError('MOODLE_HTTP', `学校接口返回 HTTP ${response.status}。`);
      return {response,url:current,external:false};
    } throw new AppError('MOODLE_REDIRECT', '学校重定向次数过多。');
  }
  async response(url: string, init?: RequestInit) {
    const generation = this.indexGeneration, result = await this.resolvedResponse(url,init);
    this.assertIndexGeneration(generation);return result.response;
  }
  async html(url: string) {
    const generation = this.indexGeneration;
    const response = await this.response(url); const html = await response.text();
    this.assertIndexGeneration(generation);
    const $ = load(html);
    const already=/You are already logged in as|您已经登录为|已登录为/i.test($('body').text());
    if (!already&&$('#page-login-index, input[type="password"], form[action*="login"]').length) throw new AppError('AUTH_REQUIRED', '学校会话已失效，请重新登录。');
    return html;
  }
  private async ajax(method: string, args: Record<string, unknown>) {
    const generation = this.indexGeneration;
    const html = await this.html(CORE + '/my/'); const match = html.match(/"sesskey"\s*:\s*"([a-zA-Z0-9]+)"/) || html.match(/sesskey\s*[:=]\s*['"]([a-zA-Z0-9]+)['"]/);
    this.assertIndexGeneration(generation);
    if (!match) throw new AppError('AJAX_UNAVAILABLE', '学校页面没有可用的 AJAX 会话。');
    const response = await this.response(`${CORE}/lib/ajax/service.php?sesskey=${encodeURIComponent(match[1])}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ index: 0, methodname: method, args }]) });
    const payload = await response.json() as Array<{ error?: boolean; data?: unknown }>;
    this.assertIndexGeneration(generation);
    if (!Array.isArray(payload) || payload[0]?.error) throw new AppError('AJAX_UNAVAILABLE', '学校尚未开放该 AJAX 功能。');
    return payload[0].data;
  }
  async listCourses(): Promise<Course[]> {
    const generation = this.indexGeneration;
    await this.ensureAuth(); let courses: Course[] = [];let fallback=false;
    this.assertIndexGeneration(generation);
    try {
      let offset = 0;
      while (offset < 1000) {
        const result = await this.ajax('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'all', limit: 100, offset, sort: 'fullname', customfieldname: '', customfieldvalue: '' }) as { courses?: Array<{ id: number; fullname: string; shortname: string }>; nextoffset?: number };
        this.assertIndexGeneration(generation);
        const batch = (result.courses ?? []).map(c => ({ id: String(c.id), name: c.fullname, shortName: c.shortname, url: `${CORE}/course/view.php?id=${c.id}` }));
        courses.push(...batch); if (!batch.length || result.nextoffset === undefined || result.nextoffset <= offset) break; offset = result.nextoffset;
      }
    } catch (e) { this.assertIndexGeneration(generation);if (e instanceof AppError && e.code === 'AUTH_REQUIRED') throw e;fallback=true;const html=await this.html(CORE + '/my/courses.php');this.assertIndexGeneration(generation);courses = parseCourses(html); }
    this.assertIndexGeneration(generation);
    if(fallback&&!courses.length)throw new AppError('COURSES_UNAVAILABLE','学校课程接口和页面列表均未提供可解析课程，请检查 App 中的学校页面。');
    this.courses = new Map(courses.map(c => [c.id,c])); return courses;
  }
  async checkedCourses(ids: string[]) {
    const generation = this.indexGeneration;
    if (!this.courses.size) await this.listCourses();
    this.assertIndexGeneration(generation);
    for (const id of ids) if (!this.courses.has(id)) throw new AppError('COURSE_UNKNOWN', '请先从课程列表选择可访问的课程 ID。');
    await this.ensureAuth();
    this.assertIndexGeneration(generation);
  }
  async listMaterials(ids: string[]) {
    const generation = this.indexGeneration;
    await this.checkedCourses(ids); const result: Material[] = [];const pageSources=new Map<string,Source>();
    this.assertIndexGeneration(generation);
    for (const courseId of ids) {
      this.assertIndexGeneration(generation);
      const course = this.courses.get(courseId)!; const html = await this.html(course.url);
      this.assertIndexGeneration(generation);
      const courseActivity = { id: courseId, courseId, name: course.name, section: 'General', url: course.url, type: 'course' };
      result.push(...parseFiles(html, courseActivity));
      for (const activity of parseActivities(html, courseId)) {
        this.assertIndexGeneration(generation);
        if (!['resource','folder','url','page','book'].includes(activity.type)) continue;
        const resolved=await this.resolvedResponse(activity.url,undefined,activity.type==='url');
        this.assertIndexGeneration(generation);
        if(resolved.external) {
          result.push({id:stableId(courseId,resolved.url),courseId,section:activity.section,name:activity.name,url:resolved.url,kind:'link',activityUrl:activity.url});
          continue;
        }
        const direct=materialFromFileResponse(activity,resolved.url,resolved.response.headers);
        if(direct){await resolved.response.body?.cancel();result.push(direct);continue;}
        const type=resolved.response.headers.get('content-type')??'';
        if(type&&!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) {
          await resolved.response.body?.cancel();
          if(activity.type==='url'||/^(?:video|audio)\//i.test(type))result.push({id:stableId(courseId,resolved.url),courseId,section:activity.section,name:activity.name,url:resolved.url,kind:'link',activityUrl:activity.url});
          continue;
        }
        const content=await resolved.response.text(),$=load(content);
        this.assertIndexGeneration(generation);
        if($('#page-login-index, input[type="password"], form[action*="login"]').length&&!/You are already logged in as|您已经登录为|已登录为/i.test($('body').text()))throw new AppError('AUTH_REQUIRED','学校会话已失效，请重新登录。');
        const files = parseFiles(content, activity),links=parseExternalLinks(content, activity); result.push(...files, ...links);
        if(!files.length&&!links.length&&['url','page','book'].includes(activity.type))result.push({id:stableId(courseId,activity.url),courseId,section:activity.section,name:activity.name,url:activity.url,kind:'link',activityUrl:activity.url});
        if (!files.length && ['page','book'].includes(activity.type)) {
          const id = stableId('page', courseId, activity.id);
          pageSources.set(id, { id, courseId, name: activity.name, url: activity.url, kind: 'announcement' });
        }
      }
    }
    this.assertIndexGeneration(generation);
    const fresh=new Map(result.map(m=>[m.id,m]));
    for(const [id,material]of this.materials)if(ids.includes(material.courseId)&&!fresh.has(id))this.materials.delete(id);
    for(const [id,source]of this.sources)if(ids.includes(source.courseId)&&((source.materialId&&!fresh.has(source.materialId))||(/\/mod\/(?:page|book)\/view\.php$/.test(new URL(source.url).pathname)&&!pageSources.has(id))))this.sources.delete(id);
    for (const material of fresh.values()) this.materials.set(material.id, material);
    for(const [id,source]of pageSources)this.sources.set(id,source);
    return [...fresh.values()];
  }
  async listDeadlines(ids?: string[], from = new Date().toISOString(), to = new Date(Date.now() + 30*86400_000).toISOString()) {
    const generation = this.indexGeneration;
    if (Date.parse(from) > Date.parse(to)) throw new AppError('DATE_RANGE', '开始时间必须早于结束时间。');
    if (!this.courses.size) await this.listCourses(); const selected = ids ?? [...this.courses.keys()]; await this.checkedCourses(selected);
    this.assertIndexGeneration(generation);
    const result: Deadline[] = []; const warnings: string[] = [];
    const addCalendarEvent=(event:Record<string,any>)=>{
      const courseId=String(event.course?.id??event.courseid??'');const url=schoolUrl(event.url??'');const at=Number(event.timesort??event.timestart);
      if(!selected.includes(courseId)||!url||!Number.isFinite(at)||at<=0)return;
      let kind:Deadline['kind']='calendar';
      if(event.modulename==='assign'||new URL(url).pathname==='/mod/assign/view.php') {
        if(event.eventtype==='due')kind='assignment_due';else if(event.eventtype==='cutoff')kind='assignment_cutoff';else return;
      }else if(event.modulename==='quiz'||new URL(url).pathname==='/mod/quiz/view.php') {
        if(event.eventtype==='close')kind='quiz_close';else return;
      }
      // Effective activity-page dates take precedence; otherwise retain the user's explicit calendar date.
      if(kind==='calendar'?result.some(d=>d.id===stableId('calendar',String(event.id))):result.some(d=>d.courseId===courseId&&d.kind===kind&&d.url===url))return;
      result.push({id:stableId('calendar',String(event.id)),courseId,name:String(event.name??''),kind,at:new Date(at*1000).toISOString(),timezone:'Asia/Shanghai',url,observedAt:new Date().toISOString(),source:'moodle'});
    };
    for (const id of selected) {
      this.assertIndexGeneration(generation);
      const activities = parseActivities(await this.html(this.courses.get(id)!.url), id);
      this.assertIndexGeneration(generation);
      for (const activity of activities.filter(a => ['assign','quiz'].includes(a.type))) {
        this.assertIndexGeneration(generation);
        try { const html=await this.html(activity.url);this.assertIndexGeneration(generation);result.push(...parseActivityDeadlines(html, activity)); }
        catch (e) { this.assertIndexGeneration(generation);if (e instanceof AppError && e.code === 'AUTH_REQUIRED') throw e; warnings.push(`无法读取活动 ${activity.name} 的截止时间。`); }
      }
    }
    try {
      let aftereventid=0;
      for(let page=0;page<20;page++) {
        const data = await this.ajax('core_calendar_get_action_events_by_timesort', { timesortfrom: Math.floor(Date.parse(from)/1000), timesortto: Math.floor(Date.parse(to)/1000), limitnum: 50, aftereventid }) as { events?: Array<Record<string, any>> };
        this.assertIndexGeneration(generation);
        const events=data.events??[];
        for (const event of events) addCalendarEvent(event);
        if(events.length<50)break;
        const next=Number(events.at(-1)?.id);
        if(!Number.isSafeInteger(next)||next===aftereventid||page===19){warnings.push('日历事件达到分页上限，请缩小时间范围查询。');break;}
        aftereventid=next;
      }
    } catch (e) { this.assertIndexGeneration(generation);if (e instanceof AppError && e.code === 'AUTH_REQUIRED') throw e; warnings.push('学校日历 AJAX 未开放；已读取作业和测验页面。'); }
    // Action events omit ordinary course calendar entries; read the monthly view as well.
    const first=new Date(Date.parse(from)+8*3600_000),last=new Date(Date.parse(to)+8*3600_000);
    const firstMonth=first.getUTCFullYear()*12+first.getUTCMonth(),lastMonth=last.getUTCFullYear()*12+last.getUTCMonth();
    if(lastMonth-firstMonth>=24)warnings.push('普通日历仅查询前 24 个月，请缩小时间范围。');
    try {
      for(let monthIndex=firstMonth;monthIndex<=Math.min(lastMonth,firstMonth+23);monthIndex++) {
        const data=await this.ajax('core_calendar_get_calendar_monthly_view',{year:Math.floor(monthIndex/12),month:monthIndex%12+1,courseid:0,includenavigation:false,mini:false,day:1,view:'month'}) as {weeks?:Array<{days?:Array<{events?:Array<Record<string,any>>}>}>};
        this.assertIndexGeneration(generation);
        for(const week of data.weeks??[])for(const day of week.days??[])for(const event of day.events??[])addCalendarEvent(event);
      }
    }catch(e){this.assertIndexGeneration(generation);if(e instanceof AppError&&e.code==='AUTH_REQUIRED')throw e;warnings.push('普通课程日历视图无法读取；活动截止时间仍可单独查询。');}
    this.assertIndexGeneration(generation);
    const unique = [...new Map(result.map(d => [d.id, d])).values()];
    return { deadlines: unique.filter(d => Date.parse(d.at) >= Date.parse(from) && Date.parse(d.at) <= Date.parse(to)).sort((a,b) => a.at.localeCompare(b.at)), warnings, observedAt: new Date().toISOString() };
  }
  async listSources(ids: string[]) {
    const generation = this.indexGeneration;
    const materials = await this.listMaterials(ids);
    this.assertIndexGeneration(generation);
    const fresh=new Map([...this.sources].filter(([,s])=>ids.includes(s.courseId)&&/\/mod\/(?:page|book)\/view\.php$/.test(new URL(s.url).pathname)));
    for (const material of materials.filter(m => m.kind === 'file')) {
      const id = stableId('source', material.id); fresh.set(id, { id, courseId: material.courseId, name: material.name, url: material.activityUrl, kind: 'material', materialId: material.id });
    }
    for (const courseId of ids) {
      this.assertIndexGeneration(generation);
      const activities = parseActivities(await this.html(this.courses.get(courseId)!.url), courseId);
      this.assertIndexGeneration(generation);
      for (const activity of activities.filter(a => a.type === 'forum')) {
        const html = await this.html(activity.url); const $ = load(html);
        this.assertIndexGeneration(generation);
        // Announcement forums are read; arbitrary discussion threads are excluded.
        if (!/announcement|通知|公告|news forum/i.test(activity.name + ' ' + $('h1,h2').text())) continue;
        for (const source of parseAnnouncementSources(html, courseId, activity.url)) fresh.set(source.id, source);
      }
    }
    this.assertIndexGeneration(generation);
    for(const [id,source]of this.sources)if(ids.includes(source.courseId)&&!fresh.has(id))this.sources.delete(id);
    for(const [id,source]of fresh)this.sources.set(id,source);
    return [...fresh.values()];
  }
  clear() { this.indexGeneration++;this.courses.clear(); this.materials.clear(); this.sources.clear(); }
}
