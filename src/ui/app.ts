import { prioritizeCourses } from '../course-order.js';

declare global {interface Window {xipu:{invoke:(command:string,payload?:unknown)=>Promise<any>;onChange:(callback:()=>void)=>()=>void}}}
export {};
const $=(selector:string)=>document.querySelector(selector) as HTMLElement;
const html=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const titles:Record<string,string>={overview:'连接概览',courses:'课程与课件',deadlines:'截止时间',downloads:'下载任务',settings:'账户与邮箱',mcp:'AI 接入'};
let view='overview',state:any,selectedCourse:string|undefined,materials:any[]=[],sources:any[]=[],sourceEvidenceHTML='',config:any,pending=false;
let navigationRevision:number|undefined,focusedDeadlineId:string|undefined,scrollDeadlineId:string|undefined;
async function invoke(command:string,payload?:unknown){const response=await window.xipu.invoke(command,payload);if(!response.ok)throw new Error(response.error.message);return response.result;}
async function tool(name:string,args:unknown={}){return invoke('tool',{name,args});}
function notice(message:string,error=false){const element=$('#notice');element.textContent=message;element.classList.toggle('error',error);element.classList.toggle('hidden',!message);}
function applyControlState(){
  document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button=>{button.disabled=pending||button.dataset.disabled==='true';});
  const login=document.getElementById('widget-login') as HTMLInputElement|null;
  if(login)login.disabled=pending||!state?.widget?.available||!state?.settings.widgets.enabled;
}
function clearLocalData(){selectedCourse=undefined;materials=[];sources=[];sourceEvidenceHTML='';focusedDeadlineId=undefined;scrollDeadlineId=undefined;}
async function action(run:()=>Promise<void>){if(pending)return;pending=true;applyControlState();try{await run();}catch(e){notice(e instanceof Error?e.message:'操作失败。',true);}finally{pending=false;await refresh(view==='deadlines');applyControlState();}}
async function refresh(render=true){try{
  const next=await invoke('state');
  if(state&&state.settings.username!==next.settings.username)clearLocalData();
  state=next;
  const navigation=state.navigation;
  const navigated=navigation?.view==='deadlines'&&navigation.revision!==navigationRevision;
  if(navigated){navigationRevision=navigation.revision;view='deadlines';focusedDeadlineId=navigation.deadlineId;scrollDeadlineId=navigation.deadlineId;}
  $('#connection-pill').textContent=state.auth.state==='authenticated'?'已连接学校':state.auth.state==='connecting'?'正在连接':'需要连接';
  $('#connection-pill').classList.toggle('connected',state.auth.state==='authenticated');
  if(render||navigated)draw();else applyControlState();
}catch(e){notice(String(e),true);applyControlState();}}
function button(label:string,action:string,cls='secondary',extra=''){return `<button class="${cls}" data-action="${action}" ${pending?'disabled':''} ${extra}>${html(label)}</button>`;}
function empty(message:string,symbol='◈'){return `<div class="empty"><div class="symbol">${symbol}</div>${html(message)}</div>`;}
function field(label:string,id:string,value:unknown,type='text',hint=''){return `<div class="field"><label for="${id}">${html(label)}</label><input id="${id}" type="${type}" value="${html(value)}" ${type==='password'?'autocomplete="new-password"':''}>${hint?`<div class="hint">${html(hint)}</div>`:''}</div>`;}
function lastSync(snapshot:any){return snapshot?.lastSuccessfulSyncAt?`最后成功更新：${new Date(snapshot.lastSuccessfulSyncAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}（上海时间）`:'尚未成功同步 DDL';}
function deadlineStatus(snapshot:any){
  if(state.widget?.syncing)return '正在同步 Moodle DDL…';
  if(snapshot?.connectionState==='error')return '同步失败 · 保留上次缓存';
  if(snapshot?.connectionState==='login_required')return '需要重新连接 Moodle · 保留上次缓存';
  if(snapshot?.connectionState==='unconfigured')return '连接 Moodle 后同步 DDL';
  if(snapshot?.warnings?.length)return '部分来源不可用 · 列表可能不完整';
  return snapshot?.lastSuccessfulSyncAt?'已同步 Moodle DDL':'刷新后查看 Moodle DDL';
}
function emptyDeadlines(snapshot:any){
  if(snapshot?.warnings?.length)return '部分来源不可用，暂未读到明确 DDL。请刷新或查看材料线索。';
  if(snapshot?.connectionState==='error')return '暂时无法同步，尚无可显示的缓存 DDL。';
  if(snapshot?.connectionState==='login_required')return '重新连接 Moodle 后查看截止时间。';
  if(!snapshot?.lastSuccessfulSyncAt)return '连接学校并刷新后，查看 Moodle 中明确记录的截止时间。';
  return '未来 30 天未发现明确截止时间。';
}
function remainingTime(at:string){const seconds=(Date.parse(at)-Date.now())/1000;return seconds<3600?'不足 1 小时':seconds<86400?`剩 ${Math.ceil(seconds/3600)} 小时`:`剩 ${Math.ceil(seconds/86400)} 天`;}
function widgetCard(snapshot:any){
  const widget=state.widget??{},prefs=state.settings.widgets??{enabled:false,launchAtLogin:true},login=widget.login??{};
  const unavailable=!widget.available&&!prefs.enabled;
  const loginMessage=login.status==='requires-approval'?'等待系统批准：请在「系统设置 → 通用 → 登录项与扩展」中允许 XIPU MCP。':login.openAtLogin?'系统已注册：登录 Mac 后在后台运行。':login.status==='not-found'?'系统未找到登录项，请重新启用小组件后检查。':'系统未启用登录时运行。';
  return `<div class="card widget-card"><div class="section-heading"><div><h2>桌面小组件 <span class="widget-label">macOS 原生</span></h2><p>正方形显示最近 2 项 · 长方形显示最近 4 项</p></div>${button(prefs.enabled?'停用小组件同步':'启用桌面小组件','toggle-widget',prefs.enabled?'secondary':'primary',unavailable?'data-disabled="true" disabled':'')}</div><div class="widget-sync"><strong>${html(deadlineStatus(snapshot))}</strong><span class="muted">${html(lastSync(snapshot))}</span></div><p class="muted">${html(widget.message)}</p><label class="widget-login"><input id="widget-login" type="checkbox" ${prefs.launchAtLogin!==false?'checked':''} ${!widget.available||!prefs.enabled||pending?'disabled':''}> 登录 Mac 后在后台运行</label><div class="hint ${login.status==='requires-approval'?'login-approval':''}">${html(loginMessage)}${login.wasOpenedAtLogin?' 本次由登录项在后台启动。':''}</div><div class="divider"></div><ol class="widget-steps"><li>右键桌面，选择「编辑小组件」。</li><li>搜索「XIPU MCP」，选择方形或长方形。</li><li>点击小组件打开截止时间；长方形可定位对应事项。</li></ol><p class="hint">启用后每小时同步，睡眠唤醒后补刷。关闭主窗口仍会同步；退出 App 后，小组件显示最后缓存。</p></div>`;
}
function draw(){
  if(!state)return;$('#page-title').textContent=titles[view];document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('selected',b.getAttribute('data-view')===view));
  let content='';
  if(view==='overview'){
    content=`<div class="card hero"><div class="eyebrow">YOUR COURSES, WITHIN REACH</div><h2>课件和截止时间，<br>连接到你的 AI 工作流。</h2><p>学校账户与二步验证在本机处理。连接后，AI 可以读取课程、下载材料，并查看有出处的截止时间。</p><div class="row">${button('连接学校','connect','primary')}${button('打开登录窗口','manual-login')}</div></div><div class="stat-grid"><div class="stat"><small>学校连接</small><strong>${state.auth.state==='authenticated'?'可用':'待连接'}</strong></div><div class="stat"><small>已发现课程</small><strong>${state.courses.length}</strong></div><div class="stat"><small>下载任务</small><strong>${state.jobs.length}</strong></div></div><div class="divider"></div><div class="grid"><div class="card"><h2>连接诊断</h2><p>${html(state.auth.message)}</p><div class="muted">${html(new Date(state.auth.checkedAt).toLocaleString('zh-CN'))}</div></div><div class="card"><h2>邮箱与隐私</h2><p>${state.settings.mail.enabled?`${html(state.settings.mail.protocol.toUpperCase())} · ${html(state.settings.mail.host)}`:'尚未开启自动取码，可手动完成验证。'}</p><div class="muted">AI 无法读取邮件、验证码或修改筛选规则。邮箱授权本身可能具有更广权限。</div></div></div>`;
  }else if(view==='settings'){
    const s=state.settings,m=s.mail;
    content=`<form id="settings-form"><div class="card"><h2>学校账户</h2><div class="grid">${field('学校用户名','school-username',s.username)}${field('学校密码','school-password','','password',state.hasSchoolPassword?'已加密保存；留空保留原密码。':'用于学校 SSO 自动登录。')}<div class="full">${field('下载目录','download-directory',s.downloadDirectory)}${button('选择文件夹','choose-directory')}</div></div></div><div class="card"><div class="section-heading"><h2>二步验证邮箱</h2><label><input id="mail-enabled" type="checkbox" ${m.enabled?'checked':''}> 启用自动取码</label></div><div class="field"><label for="mail-preset">快速填写服务器</label><select id="mail-preset"><option value="custom">自定义服务器</option><option value="qq">QQ 邮箱</option><option value="163">网易 163 邮箱</option><option value="126">网易 126 邮箱</option></select><div class="hint">预设仅填写服务器，不限制邮箱服务商。认证使用密码或应用授权码。</div></div><div class="grid"><div class="field"><label for="mail-protocol">协议</label><select id="mail-protocol"><option value="imap" ${m.protocol==='imap'?'selected':''}>IMAP（推荐）</option><option value="pop3" ${m.protocol==='pop3'?'selected':''}>POP3</option></select></div><div class="field"><label for="mail-security">连接安全</label><select id="mail-security"><option value="tls" ${m.security==='tls'?'selected':''}>SSL/TLS（直接加密）</option><option value="starttls" ${m.security==='starttls'?'selected':''}>STARTTLS（必须成功升级）</option></select></div>${field('服务器主机名','mail-host',m.host)}${field('端口','mail-port',m.port,'number')}${field('认证用户名','mail-username',m.username,'text','可以与收码邮箱地址不同。')}${field('邮箱密码／授权码','mail-password','','password',state.hasMailPassword?'已加密保存；留空保留原凭据。':'不需要填写 SMTP 配置。')}${field('接收验证码的地址','mail-recipient',m.recipient,'email')}${field('IMAP 文件夹','mail-folder',m.folder,'text','POP3 不使用文件夹配置。')}</div><div class="divider"></div><h3>验证码筛选规则</h3><div class="grid">${field('确切发件人（逗号分隔）','mail-senders',m.senders.join(', '))}${field('允许的发件人域名（逗号分隔）','mail-domains',m.senderDomains.join(', '))}${field('主题特征（逗号分隔，任一匹配）','mail-subjects',m.subjectPatterns.join(', '))}${field('验证码数字长度','mail-code-length',m.codeLength,'number')}</div><div class="warning">只处理本次登录后新增、符合发件人、收件人和主题规则的邮件。POP3 必须支持 UIDL 和 TOP；缺失时使用 IMAP 或手动输入。此限制由 App 执行，邮箱授权码本身可能具有完整邮箱读取权限。</div></div><div class="row">${button('保存设置','save-settings','primary')}${button('测试邮箱连接','test-mail')}${button('清除凭据与会话','clear-secrets','danger')}</div></form>`;
  }else if(view==='courses'){
    content=`<div class="toolbar"><p>当前账户可访问的课程与直接文件</p>${button('刷新课程','refresh-courses','primary')}</div>`;
    if(!selectedCourse)content+=`<div class="card">${state.courses.length?prioritizeCourses(state.courses).map((c:any)=>`<div class="course"><span class="course-icon">▦</span><div class="course-name"><strong>${html(c.name)}</strong><small class="muted">${html(c.shortName)} · ${html(c.id)}</small></div>${button('查看课件','course-materials','secondary',`data-course="${html(c.id)}"`)}</div>`).join(''):empty('连接学校后，点击刷新课程。','▦')}</div>`;
    else content+=`<div class="card"><div class="section-heading"><h2>${html(state.courses.find((c:any)=>c.id===selectedCourse)?.name)}</h2>${button('返回课程','back-courses')}</div><div class="toolbar"><label><input id="select-all" type="checkbox"> 选择全部直接文件</label>${button('下载所选','download-selected','primary')}</div>${materials.length?materials.map(m=>`<div class="file"><input class="material-check" type="checkbox" value="${html(m.id)}" ${m.kind==='link'?'disabled':''}><div class="file-name">${html(m.name)}<small>${html(m.section)} · ${m.kind==='link'?'链接／视频（不自动下载）':'Moodle 文件'}</small></div>${m.kind==='link'?button('打开链接','open-link','secondary',`data-url="${html(m.url)}"`):''}</div>`).join(''):empty('此课程暂无可发现的直接附件。')}</div>`;
  }else if(view==='deadlines'){
    const snapshot=state.deadlines;
    const upcoming=(snapshot?.deadlines??[]).filter((d:any)=>Date.parse(d.at)>Date.now()).sort((a:any,b:any)=>Date.parse(a.at)-Date.parse(b.at)||String(a.id).localeCompare(String(b.id)));
    content=`<div class="toolbar"><p>未来 30 天 · 上海时区 · Moodle 明确记录</p><div class="row">${button('刷新 DDL','refresh-deadlines','primary')}${button('查看材料线索','refresh-sources')}</div></div>`;
    content+=widgetCard(snapshot);
    if(snapshot?.warnings?.length)content+=`<div class="warning">${snapshot.warnings.map(html).join('<br>')}</div><br>`;
    content+=`<div class="card">${upcoming.length?upcoming.map((d:any)=>`<div class="deadline ${d.id===focusedDeadlineId?'deadline-focused':''}" data-deadline-id="${html(d.id)}"><div class="deadline-date">${html(new Date(d.at).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'short',day:'numeric'}))}<small>${html(new Date(d.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}))}</small><small>${html(remainingTime(d.at))}</small></div><div class="deadline-name"><strong>${html(d.name)}</strong><div class="muted">${html(snapshot.courses.find((c:any)=>c.id===d.courseId)?.name??d.courseId)}</div><span class="tag">${html(({assignment_due:'作业截止',assignment_cutoff:'停止提交',quiz_close:'测验关闭',calendar:'日历事件'} as any)[d.kind])}</span> ${d.submissionStatus?`<span class="tag">${html(d.submissionStatus)}</span>`:''}</div>${button('来源','open-link','secondary',`data-url="${html(d.url)}"`)}</div>`).join(''):empty(emptyDeadlines(snapshot),'◷')}</div>`;
    if(sources.length)content+=`<div class="card"><h2>课件与公告中的线索</h2><p>保留原文与出处，供 AI 核实。线索不会自动变成正式 DDL。</p>${sources.map(s=>`<div class="source"><span>${html(s.name)}</span>${button('提取文字','read-source','secondary',`data-source="${html(s.id)}"`)}</div>`).join('')}<div id="evidence">${sourceEvidenceHTML}</div></div>`;
  }else if(view==='downloads'){
    content=`<div class="toolbar"><p>文件保存在 ${html(state.settings.downloadDirectory)}</p>${button('刷新','refresh')}</div><div class="card">${state.jobs.length?[...state.jobs].reverse().map((j:any)=>{
      const finished=j.items.filter((i:any)=>['completed','skipped','failed','cancelled'].includes(i.state)).length;
      return `<div class="job"><div class="row"><strong>${html(j.createdAt?new Date(j.createdAt).toLocaleString('zh-CN'):'下载任务')}</strong><span class="tag">${j.state==='running'?'下载中':j.state==='cancelled'?'已取消':'已结束'}</span><span class="muted">${finished} / ${j.items.length}</span>${j.state==='running'?button('取消','cancel-job','secondary',`data-job="${html(j.id)}"`):j.items.some((i:any)=>['failed','cancelled'].includes(i.state))?button('重试失败项','retry-job','secondary',`data-job="${html(j.id)}"`):''}</div><progress max="${j.items.length}" value="${finished}"></progress>${j.items.map((i:any)=>`<div class="muted">${html(i.name)} · ${html(({pending:'等待',downloading:'下载中',completed:'完成',skipped:'已存在',failed:'失败',cancelled:'取消'} as any)[i.state])}${i.path?`<br>${html(i.path)}`:''}${i.error?`<div class="job-errors">${html(i.error)}</div>`:''}</div>`).join('')}</div>`;
    }).join(''):empty('选择课程课件后，下载任务会出现在这里。','↓')}</div>`;
  }else if(view==='mcp'){
    content=`<div class="card hero"><h2>将学校课程接入你的 AI。</h2><p>复制本机 MCP 配置到支持 stdio 的客户端。安装包内置运行时；首次使用先在 App 中保存账户与邮箱配置。</p>${button('生成 MCP 配置','mcp-config','primary')}</div><div class="card"><h2>本机配置</h2>${config?`<pre id="config-text">${html(JSON.stringify(config,null,2))}</pre>${button('复制配置','copy-config')}`:empty('点击生成配置，路径会根据当前 App 安装位置填写。','⌘')}</div><div class="card"><h2>可以这样问 AI</h2><p>“列出我的课程，并下载本周的课件。”<br>“未来两周有哪些作业截止？给我 Moodle 来源链接。”<br>“提取课程公告和课件中的日期线索，逐条核实。”</p><div class="muted">公开工具只访问课程、材料、DDL 和下载任务。邮箱、验证码与凭据不属于 MCP 接口。</div></div>`;
  }
  $('#content').innerHTML=content;
  applyControlState();
  if(scrollDeadlineId){const id=scrollDeadlineId;scrollDeadlineId=undefined;requestAnimationFrame(()=>{document.querySelector(`[data-deadline-id="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});});}
}
const value=(id:string)=>(document.getElementById(id) as HTMLInputElement).value.trim();
const list=(id:string)=>value(id).split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
async function saveSettings(){await invoke('save-settings',{settings:{username:value('school-username'),downloadDirectory:value('download-directory'),mail:{enabled:(document.getElementById('mail-enabled') as HTMLInputElement).checked,protocol:value('mail-protocol'),security:value('mail-security'),host:value('mail-host'),port:Number(value('mail-port')),username:value('mail-username'),recipient:value('mail-recipient'),folder:value('mail-folder'),senders:list('mail-senders'),senderDomains:list('mail-domains'),subjectPatterns:list('mail-subjects'),codeLength:Number(value('mail-code-length'))}},schoolPassword:(document.getElementById('school-password') as HTMLInputElement).value,mailPassword:(document.getElementById('mail-password') as HTMLInputElement).value});await refresh();notice('设置已保存，凭据已加密。');}
document.addEventListener('submit',event=>event.preventDefault());
document.addEventListener('click',event=>{
  const target=(event.target as HTMLElement).closest('button') as HTMLButtonElement|null;if(!target)return;
  if(target.dataset.view){view=target.dataset.view;notice('');draw();return;}
  const name=target.dataset.action;if(!name)return;
  void action(async()=>{
    switch(name){
      case 'connect':case 'manual-login':await invoke(name);notice(name==='manual-login'?'已打开学校登录窗口。':'已启动学校连接；需要人工验证时会打开登录窗口。');await refresh();break;
      case 'save-settings':await saveSettings();break;
      case 'test-mail':await saveSettings();notice('正在测试 TLS、认证及协议能力…');const test=await invoke('test-mail');notice(test.message);break;
      case 'clear-secrets':if(confirm('清除本机保存的密码、授权码及学校会话？已下载的文件会保留。')){await invoke(name);clearLocalData();notice('已清除凭据和会话。');await refresh();}break;
      case 'choose-directory':{const directory=await invoke(name);if(directory)(document.getElementById('download-directory') as HTMLInputElement).value=directory;break;}
      case 'refresh-courses':notice('正在读取课程…');await tool('list_courses');notice('');selectedCourse=undefined;await refresh();break;
      case 'course-materials':selectedCourse=target.dataset.course;notice('正在读取课件…');materials=await tool('list_materials',{courseIds:[selectedCourse]});notice('');draw();break;
      case 'back-courses':selectedCourse=undefined;draw();break;
      case 'download-selected':{const ids=Array.from(document.querySelectorAll('.material-check:checked')).map(e=>(e as HTMLInputElement).value);if(!ids.length)throw new Error('请先选择文件。');await tool('download_materials',{materialIds:ids});view='downloads';await refresh();notice('下载任务已开始。');break;}
      case 'refresh-deadlines':notice('正在读取 DDL…');await tool('list_deadlines');notice('');await refresh();break;
      case 'toggle-widget':{const prefs=state.settings.widgets;await invoke('set-widget-settings',{enabled:!prefs.enabled,launchAtLogin:prefs.launchAtLogin!==false});notice(prefs.enabled?'已停用小组件同步。':'已启用桌面小组件，请按下方说明添加。');await refresh();break;}
      case 'refresh-sources':{if(!state.courses.length)await tool('list_courses');await refresh(false);if(!state.courses.length)throw new Error('暂无可访问课程。');notice('正在发现公告和材料…');sources=await tool('list_deadline_sources',{courseIds:state.courses.map((c:any)=>c.id)});notice('');draw();break;}
      case 'read-source':{notice('正在本机提取文字…');const evidence=await tool('read_deadline_source',{sourceId:target.dataset.source});notice(evidence.warning??'文字已提取；日期线索需核实。');sourceEvidenceHTML=`<h3>${html(evidence.source.name)}</h3><div class="evidence">${evidence.sections.map((s:any)=>`[${html(s.location)}]\n${html(s.text)}`).join('\n\n')}${evidence.nextOffset!==null?'\n\n后续文字可由 MCP 分页读取。':''}</div>`;if(view==='deadlines')draw();break;}
      case 'cancel-job':await tool('cancel_download_job',{jobId:target.dataset.job});await refresh();break;
      case 'retry-job':{const job=state.jobs.find((j:any)=>j.id===target.dataset.job);await tool('list_courses');await tool('list_materials',{courseIds:state.courses.map((c:any)=>c.id)});await tool('download_materials',{materialIds:job.items.filter((i:any)=>['failed','cancelled'].includes(i.state)).map((i:any)=>i.materialId),retryJobId:job.id});await refresh();break;}
      case 'mcp-config':config=await invoke(name);draw();break;
      case 'copy-config':await navigator.clipboard.writeText(JSON.stringify(config,null,2));notice('MCP 配置已复制。');break;
      case 'open-link':await invoke(name,target.dataset.url);break;
      case 'refresh':await refresh();break;
    }
  });
});
document.addEventListener('change',event=>{
  const target=event.target as HTMLInputElement;
  if(target.id==='widget-login'){const launchAtLogin=target.checked;void action(async()=>{await invoke('set-widget-settings',{enabled:state.settings.widgets.enabled,launchAtLogin});notice(launchAtLogin?'已请求登录 Mac 后在后台运行。':'已关闭登录 Mac 后在后台运行。');await refresh();});return;}
  if(target.id==='select-all')document.querySelectorAll('.material-check:not(:disabled)').forEach(e=>(e as HTMLInputElement).checked=target.checked);
  if(['mail-protocol','mail-security','mail-preset'].includes(target.id)){
    const protocol=value('mail-protocol'),security=value('mail-security');(document.getElementById('mail-port') as HTMLInputElement).value=String(security==='tls'?(protocol==='imap'?993:995):(protocol==='imap'?143:110));
    const preset=value('mail-preset');if(preset!=='custom')(document.getElementById('mail-host') as HTMLInputElement).value=`${protocol}.${preset}.com`;
  }
});
window.xipu.onChange(()=>{void refresh(view==='overview'||view==='downloads'||view==='deadlines');});
setInterval(()=>{if(view==='deadlines'&&!pending)draw();},60_000);
void refresh();
