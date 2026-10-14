import { mkdir, lstat, realpath, open, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, type DownloadJob, type Material, publicError } from './shared.js';
import { MoodleClient } from './moodle/client.js';
import { Store } from './store.js';
import { atomicJson } from './files.js';

export function safeFilename(value:string) {
  const clean=value.normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g,'_').replace(/^\.+/,'').replace(/[. ]+$/,'').trim();
  return (clean||'material').slice(0,140);
}
export function materialFilename(material: Material) {
  const name=safeFilename(material.name);const extension=path.extname(name);
  return name.slice(0,name.length-extension.length)+'--'+material.id.slice(0,10)+extension;
}
export function rejectLoginFile(bytes:Uint8Array,contentType:string) {
  const text=new TextDecoder().decode(bytes.subarray(0,128*1024));
  if(/text\/html/i.test(contentType)&&/page-login-index|Log in to Learning Mall Core|XJTLU Authentication Centre|<input[^>]+type=["']password/i.test(text))
    throw new AppError('AUTH_REQUIRED','下载返回学校登录页，请重新登录后重试。');
}
export class DownloadManager {
  private controllers=new Map<string,AbortController>(); private tasks=new Set<Promise<void>>();
  constructor(private moodle:MoodleClient,private store:Store,private changed:()=>void){}
  list(){return this.store.jobs;}
  get(id:string){const job=this.store.jobs.find(j=>j.id===id);if(!job)throw new AppError('JOB_UNKNOWN','下载任务不存在。');return job;}
  async start(ids:string[],retryJobId?:string) {
    let selected=[...new Set(ids)];
    if(retryJobId) {const failed=new Set(this.get(retryJobId).items.filter(i=>['failed','cancelled'].includes(i.state)).map(i=>i.materialId));selected=selected.filter(id=>failed.has(id));}
    if(!selected.length)throw new AppError('NO_MATERIALS','没有可下载或可重试的文件。');
    for(const id of selected)if(this.moodle.materials.get(id)?.kind!=='file')throw new AppError('MATERIAL_UNKNOWN','请先列出课件，并选择 Moodle 直接文件 ID。');
    const job:DownloadJob={id:randomUUID(),state:'running',createdAt:new Date().toISOString(),items:selected.map(id=>({materialId:id,name:this.moodle.materials.get(id)!.name,state:'pending'}))};
    this.store.jobs.push(job);await this.store.saveJobs();this.changed();
    const controller=new AbortController();this.controllers.set(job.id,controller);
    const task=this.run(job,controller).finally(()=>{this.controllers.delete(job.id);this.tasks.delete(task);});this.tasks.add(task);return job;
  }
  async cancel(id:string){const job=this.get(id);this.controllers.get(id)?.abort();if(job.state==='running')job.state='cancelled';await this.store.saveJobs();this.changed();return job;}
  private async run(job:DownloadJob,controller:AbortController) {
    try {
      for(const item of job.items) {
        if(controller.signal.aborted){item.state='cancelled';continue;}
        item.state='downloading';this.changed();
        try {const material=this.moodle.materials.get(item.materialId);if(!material)throw new AppError('MATERIAL_UNKNOWN','课件列表已更新，该材料不再可用，请重新选择。');const result=await this.download(material,controller.signal);Object.assign(item,result,{state:result.skipped?'skipped':'completed'});}
        catch(e){item.state=controller.signal.aborted?'cancelled':'failed';item.error=publicError(e).message;}
        await this.store.saveJobs();this.changed();
      }
    } catch {for(const item of job.items)if(['pending','downloading'].includes(item.state)){item.state='failed';item.error='下载任务无法保存，请检查磁盘权限。';}}
    finally{job.state=controller.signal.aborted?'cancelled':'completed';try{await this.store.saveJobs();}catch{/* UI retains in-memory job */}this.changed();}
  }
  private async destination(material:Material) {
    const root=path.resolve(this.store.settings.downloadDirectory);await mkdir(root,{recursive:true});const realRoot=await realpath(root);
    const course=this.moodle.courses.get(material.courseId);const directories=[safeFilename((course?.name??material.courseId)+'--'+material.courseId),safeFilename(material.section)];
    let directory=realRoot;
    for(const component of directories) {
      directory=path.join(directory,component);try{await mkdir(directory);}catch(e:any){if(e.code!=='EEXIST')throw e;}
      const stat=await lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new AppError('PATH_DENIED','下载目录包含符号链接或无效路径。');
      const actual=await realpath(directory);if(!actual.startsWith(realRoot+path.sep))throw new AppError('PATH_DENIED','文件路径超出下载目录。');
    }
    return path.join(directory,materialFilename(material));
  }
  async download(material:Material,signal?:AbortSignal,maxBytes?:number) {
    const destination=await this.destination(material),manifest=destination+'.xipu.json';
    try {
      const stat=await lstat(destination);if(stat.isSymbolicLink()||!stat.isFile())throw new AppError('PATH_DENIED','目标文件类型无效。');
      const metadata=JSON.parse(await readFile(manifest,'utf8'));
      if(metadata.materialId===material.id&&metadata.modified===material.modified&&metadata.bytes===stat.size&&metadata.sha256) {
        const hash=createHash('sha256');const fd=await open(destination,'r');try{for await(const chunk of fd.createReadStream())hash.update(chunk);}finally{await fd.close().catch(()=>undefined);}
        if(hash.digest('hex')===metadata.sha256){
          let unchanged=false;
          if(metadata.etag||metadata.lastModified)try{
            const head=await this.moodle.response(material.url,{method:'HEAD',signal});
            const etag=head.headers.get('etag');
            unchanged=metadata.etag&&etag?etag===metadata.etag:!!(metadata.lastModified&&head.headers.get('last-modified')===metadata.lastModified);
          }catch{/* Re-download when the server cannot validate the existing file. */}
          if(unchanged)return {path:destination,bytes:stat.size,skipped:true};
        }
      }
    } catch(e){if(e instanceof AppError)throw e;}
    const temporary=destination+'.'+randomUUID()+'.part';let handle:Awaited<ReturnType<typeof open>>|undefined;
    try {
      const response=await this.moodle.response(material.url,{signal});const reader=response.body?.getReader();if(!reader)throw new AppError('DOWNLOAD_EMPTY','学校返回空文件。');
      if(maxBytes&&Number(response.headers.get('content-length'))>maxBytes){await reader.cancel();throw new AppError('DOCUMENT_TOO_LARGE','文字提取仅支持 40 MB 以内材料。');}
      const contentType=response.headers.get('content-type')??'';
      if(/text\/html/i.test(contentType)&&! /\.html?$/i.test(material.name)){await reader.cancel();throw new AppError('DOWNLOAD_TYPE','学校返回 HTML 页面而非预期文件，请检查会话后重试。');}
      handle=await open(temporary,'wx',0o600);const hash=createHash('sha256');let bytes=0;let prefix=Buffer.alloc(0);
      try {
        while(true) {
          signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;
          if(prefix.length<128*1024&&/text\/html/i.test(contentType)){prefix=Buffer.concat([prefix,chunk.value.subarray(0,128*1024-prefix.length)]);rejectLoginFile(prefix,contentType);}
          bytes+=chunk.value.length;if(maxBytes&&bytes>maxBytes)throw new AppError('DOCUMENT_TOO_LARGE','文字提取仅支持 40 MB 以内材料。');hash.update(chunk.value);await handle.writeFile(chunk.value);
        }
      }finally{await reader.cancel().catch(()=>undefined);}
      if(!bytes)throw new AppError('DOWNLOAD_EMPTY','文件为空，未写入目标。');
      const expected=Number(response.headers.get('content-length'));if(expected&&expected!==bytes&&!response.headers.get('content-encoding'))throw new AppError('DOWNLOAD_INCOMPLETE','文件长度不完整，请重试。');
      await handle.sync();await handle.close();handle=undefined;signal?.throwIfAborted();
      if(await this.destination(material)!==destination)throw new AppError('PATH_DENIED','下载目录在传输期间已改变，请重试。');
      // Refuse to replace a symlink added while the network transfer was in progress.
      try{if((await lstat(destination)).isSymbolicLink())throw new AppError('PATH_DENIED','目标文件是符号链接。');}catch(e:any){if(e.code!=='ENOENT')throw e;}
      await rename(temporary,destination);
      await atomicJson(manifest,{materialId:material.id,modified:material.modified,bytes,sha256:hash.digest('hex'),etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified')});
      return {path:destination,bytes,skipped:false};
    }finally{await handle?.close().catch(()=>undefined);await rm(temporary,{force:true});}
  }
  async shutdown(){for(const c of this.controllers.values())c.abort();await Promise.allSettled(this.tasks);}
}
