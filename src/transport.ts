import { net,type Session } from 'electron';
import { AppError,CORE } from './shared.js';
import { responseHeaders } from './http-headers.js';

/** Authenticated school-only transport. Explicit cookies remain inside the local process. */
export class SchoolSessionTransport {
  constructor(private session:Session){}
  async fetch(url:string,init:RequestInit={}):Promise<Response>{
    const target=new URL(url);if(target.origin!==CORE)throw new AppError('URL_DENIED','只允许请求学校 Moodle 来源。');
    const cookies=await this.session.cookies.get({url});
    const headers=new Headers(init.headers);if(cookies.length)headers.set('Cookie',cookies.map(c=>c.name+'='+c.value).join('; '));
    headers.set('User-Agent',this.session.getUserAgent());
    return new Promise((resolve,reject)=>{
      const request=net.request({url,method:init.method??'GET',session:this.session,credentials:'include',origin:CORE,redirect:'manual'});
      const signal=init.signal??AbortSignal.timeout(30_000);let settled=false;
      const abort=()=>{request.abort();if(!settled)reject(new AppError('NETWORK_TIMEOUT','学校请求超时或已取消。'));};
      if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
      const finish=()=>signal.removeEventListener('abort',abort);
      request.on('error',()=>{finish();if(!settled)reject(new AppError('NETWORK_CONNECTION','学校网络请求失败，请检查网络和代理。'));});
      request.on('redirect',(status,_method,location,rawHeaders)=>{
        if(settled)return;let h:Headers;
        try{h=responseHeaders(rawHeaders,url);h.set('location',new URL(location,url).href);}catch{settled=true;finish();request.abort();reject(new AppError('MOODLE_HEADERS','学校返回无效响应头，请重试。'));return;}
        settled=true;finish();
        resolve(new Response(null,{status,headers:h}));request.abort();
      });
      request.on('response',incoming=>{
        if(settled)return;let h:Headers;
        try{h=responseHeaders(incoming.headers,url);}catch{settled=true;finish();request.abort();reject(new AppError('MOODLE_HEADERS','学校返回无效响应头，请重试。'));return;}
        settled=true;
        const status=incoming.statusCode;
        if(init.method==='HEAD'||[204,205,304].includes(status)){incoming.on('end',finish);incoming.on('data',()=>undefined);resolve(new Response(null,{status,headers:h}));return;}
        let done=false;
        const body=new ReadableStream<Uint8Array>({
          start(controller){incoming.on('data',chunk=>{if(!done)controller.enqueue(new Uint8Array(chunk));});incoming.on('end',()=>{finish();if(!done){done=true;controller.close();}});incoming.on('error',()=>{finish();if(!done){done=true;controller.error(new AppError('NETWORK_CONNECTION','学校文件传输中断。'));}});signal.addEventListener('abort',()=>{if(!done){done=true;controller.error(new AppError('NETWORK_TIMEOUT','学校请求超时或已取消。'));}},{once:true});},
          cancel(){done=true;finish();request.abort();},
        });
        // Chromium has already decoded transfer/content encodings; prevent false length comparisons.
        if(h.has('content-encoding'))h.delete('content-length');
        resolve(new Response(body,{status,headers:h}));
      });
      headers.forEach((value,key)=>request.setHeader(key,value));
      if(init.body){if(typeof init.body!=='string'){finish();request.abort();reject(new AppError('REQUEST_BODY','学校接口只接受受控 JSON 请求。'));return;}request.write(init.body);}
      request.end();
    });
  }
}
