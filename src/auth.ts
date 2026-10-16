import { app, BrowserWindow, session, type Session } from 'electron';
import { AppError, CORE, SSO, type AuthStatus } from './shared.js';
import { Store } from './store.js';
import { MailService, type Baseline } from './mail/service.js';
import { SchoolSessionTransport } from './transport.js';
import { checkSchoolSession } from './moodle/session-check.js';
import { loadSchoolLoginPage, loginLoadMessage, loginFailureDocument, isLoginRedirectLoop, LOGIN_RETRY_URL } from './auth-navigation.js';
import { resetSchoolLoginCookies } from './auth-session.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class AuthService {
  readonly session: Session;
  readonly transport: SchoolSessionTransport;
  status: AuthStatus = { state:'signed_out', message:'尚未连接学校。', checkedAt:new Date().toISOString() };
  private window?: BrowserWindow; private pending?: Promise<void>; private lastChecked = 0; private lastFailed = 0;
  private controller?: AbortController;
  private windowLoadFailed = false;
  private resetSessionOnRetry = false;
  private diagnostic: AuthStatus['diagnostic'];
  constructor(private store: Store, private changed: () => void) {
    this.session = session.fromPartition('xipu-private');
    // Some SSO front ends reject Electron's application tokens; retain Chromium's normal browser UA.
    this.session.setUserAgent(this.session.getUserAgent().replace(/\sElectron\/\S+/g,'').replace(/\sxipu-mcp\/\S+/gi,''));
    this.transport = new SchoolSessionTransport(this.session);
    this.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    if(!app.isPackaged && process.env.XIPU_SESSION_DIAGNOSTICS==='1') {
      const filter={urls:[CORE+'/*',SSO+'/*']};
      this.session.webRequest.onSendHeaders(filter,details=>{
        const path=new URL(details.url).pathname;
        if(details.resourceType!=='mainFrame'&&!/^\/(my\/|lib\/ajax\/)/.test(path))return;
        const cookie=Object.entries(details.requestHeaders).find(([key])=>key.toLowerCase()==='cookie')?.[1]??'';
        console.error(JSON.stringify({sessionRequest:{host:new URL(details.url).hostname,path,type:details.resourceType,webContentsId:details.webContentsId,cookieNames:cookie.split(';').map(v=>v.trim().split('=')[0]).filter(Boolean)}}));
      });
      this.session.webRequest.onHeadersReceived(filter,(details,callback)=>{
        const returned=Object.entries(details.responseHeaders??{}).filter(([key])=>key.toLowerCase()==='set-cookie').flatMap(([,values])=>values);
        if(returned.length&&(details.resourceType==='mainFrame'||/^\/(my\/|lib\/ajax\/|esc-sso\/api\/)/.test(new URL(details.url).pathname)))console.error(JSON.stringify({sessionResponse:{host:new URL(details.url).hostname,path:new URL(details.url).pathname,status:details.statusCode,setCookieNames:returned.map(v=>v.split('=')[0])}}));
        callback({});
      });
    }
  }
  set(state: AuthStatus['state'], message: string) { this.status = { state, message, checkedAt:new Date().toISOString(),diagnostic:this.diagnostic }; this.changed(); }
  async restore() {
    for (const cookie of this.store.secrets.cookies ?? []) {
      const domain = (cookie.domain??'').replace(/^\./,''); if (!['core.xjtlu.edu.cn','uim.xjtlu.edu.cn','xjtlu.edu.cn'].includes(domain)) continue;
      try { await this.session.cookies.set({ url:`https://${domain}${cookie.path}`, name:cookie.name, value:cookie.value, domain:cookie.domain, path:cookie.path, secure:cookie.secure, httpOnly:cookie.httpOnly, expirationDate:cookie.expirationDate, sameSite:cookie.sameSite }); } catch { /* an expired cookie is ignored */ }
    }
    if (await this.probe()) this.set('authenticated','学校会话可用。');
    else this.set(this.store.settings.username ? 'signed_out':'unconfigured','请配置账户或连接学校。');
  }
  async persist(current: () => boolean = () => true) {
    const cookies = await this.session.cookies.get({});
    if (!current()) return false;
    this.store.secrets.cookies = cookies.filter(c => ['core.xjtlu.edu.cn','uim.xjtlu.edu.cn','xjtlu.edu.cn'].includes((c.domain??'').replace(/^\./,'')));
    await this.store.saveSecrets();
    return current();
  }
  private async probe() {
    try {
      const result=await checkSchoolSession(this.transport);this.diagnostic=result.diagnostic;this.status.diagnostic=result.diagnostic;return result.authenticated;
    } catch (e) {this.diagnostic={stage:e instanceof AppError?e.code:'network_failure'};return false; }
  }
  invalidate() { this.lastChecked = 0; this.set('signed_out','学校会话已失效。'); }
  async ensureBackground() {
    if (this.status.state !== 'authenticated' || this.pending) throw new AppError('AUTH_REQUIRED','请在 App 中连接学校后刷新截止时间。');
    if (Date.now()-this.lastChecked < 60_000) return;
    const status = this.status;
    const username = this.store.settings.username;
    const authenticated = await this.probe();
    if (status !== this.status || username !== this.store.settings.username || this.status.state !== 'authenticated' || this.pending) {
      // A newer check may have authenticated the same account while this probe was pending.
      if (username === this.store.settings.username && this.status.state === 'authenticated' && !this.pending && Date.now()-this.lastChecked < 60_000) return;
      throw new AppError('AUTH_REQUIRED','学校连接已改变，请在 App 中检查登录。');
    }
    if (!authenticated) { this.invalidate(); throw new AppError('AUTH_REQUIRED','学校会话已失效，请在 App 中重新连接。'); }
    this.lastChecked = Date.now();
    this.set('authenticated','学校会话可用。');
  }
  async ensure() {
    if (this.status.state === 'authenticated' && Date.now()-this.lastChecked < 60_000) return;
    if(this.pending)throw new AppError('AUTH_CONNECTING','App 正在连接学校，请等待 auth_status 返回 authenticated 后重试。');
    if (await this.probe()) { this.lastChecked = Date.now(); this.set('authenticated','学校会话可用。'); return; }
    if (Date.now()-this.lastFailed < 60_000) throw new AppError('AUTH_REQUIRED','自动登录已暂停，请在 App 中检查登录窗口。');
    void this.connect(false).catch(()=>undefined);
    throw new AppError('AUTH_CONNECTING','已在 App 中启动学校登录，请通过 auth_status 检查进度后重试。');
  }
  async connect(manual: boolean): Promise<void> {
    if(manual&&this.window&&!this.window.isDestroyed()&&!this.windowLoadFailed){this.window.show();this.window.focus();return;}
    if (this.pending&&!this.windowLoadFailed) return this.pending;
    this.controller?.abort();this.window?.close();
    const controller = new AbortController();this.controller = controller;this.windowLoadFailed = false;
    const pending = this.run(manual,controller).finally(() => { if(this.pending===pending)this.pending = undefined; });
    this.pending=pending;return pending;
  }
  private async run(manual: boolean, controller: AbortController) {
    const isCurrent=()=>this.controller===controller&&!controller.signal.aborted;
    const authenticated=await this.probe();
    if(!isCurrent())return;
    if (authenticated) { this.set('authenticated','学校会话可用。'); this.lastChecked=Date.now(); return; }
    if(this.resetSessionOnRetry||this.diagnostic?.stage==='redirect_limit') {
      this.set('connecting','学校登录会话发生循环跳转，正在重建本机登录会话。');
      try {
        await resetSchoolLoginCookies(this.session,controller.signal);
        if(!isCurrent()||!await this.persist(isCurrent))return;
        this.resetSessionOnRetry=false;
      }catch{
        if(!isCurrent())return;
        const message='无法重建学校登录会话，请检查钥匙串后重新连接。';this.set('needs_user',message);throw new AppError('AUTH_REQUIRED',message);
      }
    }
    const win = new BrowserWindow({ width:1000,height:760, show:manual, title:'学校登录 · XIPU MCP', webPreferences:{ session:this.session, nodeIntegration:false, contextIsolation:true, sandbox:true,backgroundThrottling:false } });
    this.window = win;
    win.webContents.setUserAgent(this.session.getUserAgent());
    win.on('page-title-updated',(event,title)=>{event.preventDefault();win.setTitle((title||'学校登录').replace(/(?: · XIPU MCP)+$/,'')+' · XIPU MCP');});
    if(!app.isPackaged && process.env.XIPU_SESSION_DIAGNOSTICS==='1'){
      win.webContents.on('did-navigate',(_event,url)=>{
        if(new URL(url).origin!==CORE)return;
        void(async()=>{
          const cookies=await this.session.cookies.get({url:CORE+'/my/'});
          const windowCookies=await win.webContents.session.cookies.get({url:CORE+'/my/'});
          console.error(JSON.stringify({sessionDiagnostic:{origin:CORE,path:new URL(url).pathname,sameSession:win.webContents.session===this.session,cookies:cookies.map(c=>({name:c.name,domain:c.domain,path:c.path,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite,hasValue:!!c.value})),windowCookieCount:windowCookies.length}}));
        })().catch(()=>undefined);
      });
    }
    const allowed = (url: string) => { try { const target=new URL(url);return !target.username&&!target.password&&[CORE,SSO].includes(target.origin); } catch { return false; } };
    win.webContents.on('will-navigate', (event,url) => {
      if(url===LOGIN_RETRY_URL&&this.windowLoadFailed){event.preventDefault();void this.connect(true).catch(()=>undefined);return;}
      if (!allowed(url)) { event.preventDefault();void this.showLoadFailure(win,controller,{reason:'origin'}); }
    });
    win.webContents.on('will-redirect', (event,url) => { if (!allowed(url)) {event.preventDefault();void this.showLoadFailure(win,controller,{reason:'origin'});} });
    win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    win.webContents.on('did-fail-load', (_e, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) void this.showLoadFailure(win,controller,{reason:'load_failed',errorCode:code}); });
    win.webContents.on('render-process-gone',()=>{void this.showLoadFailure(win,controller,{reason:'renderer'});});
    win.on('closed', () => { controller.abort();if (this.window === win) {this.window=undefined;this.windowLoadFailed=false;if(this.status.state==='connecting')this.set('signed_out','学校登录窗口已关闭，请重新连接。');} });
    this.set('connecting','正在打开 Moodle 并检查学校 SSO。');
    let baseline: Baseline | undefined; let mail: MailService | undefined;
    let submitted=false, submittedAt=0, otpSubmitted=false, sendClicked=false, attemptedMail=false;
    try {
      await loadSchoolLoginPage(win,CORE+'/login/index.php',controller.signal);
      const until = Date.now()+300_000;
      while (Date.now()<until && !win.isDestroyed()) {
        controller.signal.throwIfAborted();
        if(!isCurrent())return;
        if(this.windowLoadFailed)throw new AppError('AUTH_LOAD','学校页面加载失败，请在登录窗口重新加载。');
        const current = win.webContents.getURL();
        if (!allowed(current)) throw new AppError('AUTH_ORIGIN','学校登录来源不在允许列表。');
        if (new URL(current).origin === CORE && !/\/login\/|\/auth\//.test(new URL(current).pathname) && await this.probe()) {
          if(controller.signal.aborted||this.controller!==controller)return;
          if(!await this.persist(()=>this.controller===controller&&!controller.signal.aborted))return;
          this.lastChecked=Date.now(); this.lastFailed=0; this.set('authenticated','已连接学校。'); win.close(); return;
        }
        const state = await win.webContents.executeJavaScriptInIsolatedWorld(901, [{ code:`(() => {
          const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
          const inputs=[...document.querySelectorAll('input')].filter(visible);
          const labels=e=>[e.name,e.id,e.placeholder,e.getAttribute('autocomplete')].join(' ');
          const password=inputs.some(e=>e.type==='password');
          const otp=inputs.some(e=>e.type!=='password'&&/otp|verification|verifycode|one-time-code|验证码|security.?code/i.test(labels(e)));
          const error=[...document.querySelectorAll('[role=alert], .el-message--error, .alert-danger, .error-message')].filter(visible).some(e=>e.textContent.trim());
          const link=[...document.querySelectorAll('a[href]')].find(e=>e.href.includes('/auth/saml2/login.php'));
          return {password,otp,error,sso:link?.href??null};
        })()` }]);
        if (state.error) throw new AppError('AUTH_REJECTED','学校登录返回错误，请在登录窗口检查后手动操作。');
        if(controller.signal.aborted||this.controller!==controller)return;
        if (state.sso && new URL(current).origin===CORE) { if (!allowed(state.sso)) throw new AppError('AUTH_ORIGIN','无效的学校 SSO 地址。'); await loadSchoolLoginPage(win,state.sso,controller.signal); continue; }
        if (!manual && state.password && !submitted && new URL(current).origin === SSO) {
          if (!this.store.settings.username || !this.store.secrets.schoolPassword) throw new AppError('AUTH_CONFIG','请在 App 配置学校账户，或手动登录。');
          if (this.store.settings.mail.enabled && this.store.secrets.mailPassword) {
            attemptedMail=true; mail = new MailService(this.store.settings.mail,this.store.secrets.mailPassword);
            try { baseline=await mail.baseline(); } catch { mail=undefined;if(isCurrent())this.set('connecting','邮箱连接失败；学校登录需要验证码时请手动输入。'); }
          }
          if(controller.signal.aborted||this.controller!==controller)return;
          await this.fillPassword(win);if(!isCurrent())return;submitted=true;submittedAt=Date.now();this.set('connecting','已提交学校登录，正在等待验证或回跳。');
        }
        if (state.otp && !otpSubmitted) {
          if (manual || !mail || !baseline) throw new AppError('OTP_MANUAL','请在学校登录窗口输入邮箱验证码。');
          if (!sendClicked) { await this.clickSendCode(win); sendClicked=true; }
          this.set('connecting','正在等待符合筛选条件的验证码邮件。');
          const code=await mail.waitForCode(baseline,controller.signal);
          if(controller.signal.aborted||this.controller!==controller)return;
          await this.fillOtp(win,code); otpSubmitted=true;
        }
        if (submitted && !state.otp && Date.now()-submittedAt>90_000) throw new AppError('AUTH_TIMEOUT','学校登录提交后没有明确响应，请在登录窗口手动检查。');
        await pause(1000);
      }
      throw new AppError('AUTH_TIMEOUT',attemptedMail ? '登录未完成，请检查学校页面和邮箱连接。':'登录未完成，请在登录窗口检查。');
    } catch (error) {
      if(!isCurrent()||win.isDestroyed())return;
      this.lastFailed=Date.now();
      const url=win.webContents.getURL();
      if(this.windowLoadFailed||!allowed(url)||(error as {reason?:string})?.reason){await this.showLoadFailure(win,controller,error);throw new AppError('AUTH_REQUIRED',this.status.message);}
      const message=error instanceof AppError ? error.message:'登录未完成，请在学校登录窗口手动检查。';
      this.set('needs_user',message); if (!win.isDestroyed()) { win.show(); this.watchManual(win,controller); }
      throw new AppError('AUTH_REQUIRED',message);
    }
  }
  private async showLoadFailure(win:BrowserWindow,controller:AbortController,error:unknown) {
    if(this.controller!==controller||controller.signal.aborted||win.isDestroyed()||this.window!==win||this.windowLoadFailed)return;
    this.windowLoadFailed=true;
    this.lastFailed=Date.now();
    if(isLoginRedirectLoop(error))this.resetSessionOnRetry=true;
    const message=loginLoadMessage(error);this.set('needs_user',message);win.show();
    try {await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(loginFailureDocument(message)));} catch { /* The main App also retains the safe error message. */ }
  }
  private async fillPassword(win: BrowserWindow) {
    const values=JSON.stringify({ username:this.store.settings.username, password:this.store.secrets.schoolPassword });
    await win.webContents.executeJavaScriptInIsolatedWorld(901,[{ code:`(() => {
      const values=${values};const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
      const inputs=[...document.querySelectorAll('input')].filter(visible);const password=inputs.find(e=>e.type==='password');
      const username=inputs.find(e=>e!==password&&/user|account|用户名|账号/i.test([e.name,e.id,e.placeholder].join(' ')))||inputs.find(e=>['text','email'].includes(e.type));
      const button=[...document.querySelectorAll('button,input[type=submit]')].filter(visible).find(e=>/sign.?in|log.?in|登录/i.test(e.textContent||e.value));
      if(!username||!password||!button)throw new Error('Unknown login form');
      const fill=(e,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
      fill(username,values.username);fill(password,values.password);button.click();
    })()` }]);
  }
  private async clickSendCode(win: BrowserWindow) {
    await win.webContents.executeJavaScriptInIsolatedWorld(901,[{ code:`(() => {const buttons=[...document.querySelectorAll('button,input[type=button],input[type=submit]')];const b=buttons.find(e=>/send.*code|get.*code|发送.*验证码|获取.*验证码/i.test(e.textContent||e.value));if(b&&!b.disabled)b.click();})()` }]);
  }
  private async fillOtp(win: BrowserWindow, code: string) {
    await win.webContents.executeJavaScriptInIsolatedWorld(901,[{ code:`(() => {
      const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
      const e=[...document.querySelectorAll('input')].filter(visible).find(e=>/otp|verification|verifycode|one-time-code|验证码|security.?code/i.test([e.name,e.id,e.placeholder,e.getAttribute('autocomplete')].join(' ')));
      const b=[...document.querySelectorAll('button,input[type=submit]')].filter(visible).find(e=>/verify|confirm|sign.?in|log.?in|确认|验证|登录/i.test(e.textContent||e.value));
      if(!e||!b)throw new Error('Unknown OTP form');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(code)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));b.click();
    })()` }]);
  }
  private watchManual(win: BrowserWindow,controller:AbortController) {
    const current=()=>this.window===win&&!win.isDestroyed()&&this.controller===controller&&!controller.signal.aborted&&!this.windowLoadFailed;
    let checking=false;
    const timer=setInterval(async () => {
      if(!current()) {clearInterval(timer);return;}
      if(checking)return;checking=true;
      try {
        if(await this.probe()&&current()) {try{if(!await this.persist(current))return;clearInterval(timer);this.lastChecked=Date.now();this.lastFailed=0;this.set('authenticated','已通过人工登录连接学校。');win.close();}catch{if(current())this.set('needs_user','登录已完成，但无法保存会话；请检查钥匙串。');}}
      }finally{checking=false;}
    },5000);
    timer.unref();win.once('closed',()=>clearInterval(timer));
  }
  async clear() { this.controller?.abort();this.pending=undefined;this.resetSessionOnRetry=false;this.window?.close();await this.session.clearStorageData();await this.store.clearSecrets();this.lastChecked=0;this.lastFailed=0;this.set('signed_out','已清除凭据和学校会话。'); }
}
