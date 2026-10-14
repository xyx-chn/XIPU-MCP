import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,readdir,mkdir,symlink,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Store } from '../src/store.js';
import { atomicJson } from '../src/files.js';
import { MoodleClient } from '../src/moodle/client.js';
import { DownloadManager } from '../src/downloads.js';
import { CORE,SettingsSchema,type Material } from '../src/shared.js';

async function fixture(response:(init?:RequestInit)=>Response){
  const root=await mkdtemp(path.join(tmpdir(),'xipu-download-'));
  const fake={directory:path.join(root,'state'),settings:SettingsSchema.parse({downloadDirectory:path.join(root,'downloads'),mail:{}}),jobs:[] as Store['jobs'],saveJobs:async()=>{await atomicJson(path.join(fake.directory,'jobs.json'),fake.jobs);}};
  const store=fake as unknown as Store;
  const client=new MoodleClient({fetch:async(_url,init)=>response(init)},async()=>undefined);client.courses.set('42',{id:'42',name:'Maths',shortName:'MTH',url:CORE+'/course/view.php?id=42'});
  const material:Material={id:'abcdef1234567890',name:'../../lecture.pdf',courseId:'42',section:'Week 1',url:CORE+'/pluginfile.php/1/mod_resource/content/0/lecture.pdf',activityUrl:CORE+'/mod/resource/view.php?id=1',kind:'file'};
  client.materials.set(material.id,material);const manager=new DownloadManager(client,store,()=>undefined);
  return {root,store,client,material,manager,close:async()=>{await manager.shutdown();await rm(root,{recursive:true,force:true});}};
}
test('downloads are atomic, validated, and skip unchanged files but refresh changed content',async()=>{
  let version=1,gets=0;const f=await fixture(init=>{if(init?.method!=='HEAD')gets++;return new Response(init?.method==='HEAD'?null:`PDF ${version}`,{headers:{'content-type':'application/pdf',etag:`"v${version}"`}});});
  try{
    f.material.modified=Date.parse('2026-10-14T00:00:00Z');
    const first=await f.manager.download(f.material);assert(first.path.startsWith(await realpath(f.store.settings.downloadDirectory)));assert.equal(await readFile(first.path,'utf8'),'PDF 1');
    assert.equal((await f.manager.download(f.material)).skipped,true);assert.equal(gets,1);
    version=2;assert.equal((await f.manager.download(f.material)).skipped,false);assert.equal(await readFile(first.path,'utf8'),'PDF 2');
    assert(!(await readdir(path.dirname(first.path))).some(file=>file.endsWith('.part')));
  }finally{await f.close();}
});
test('failed and cancelled transfers leave no partial destination',async()=>{
  const f=await fixture(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('partial'));controller.error(new Error('interrupted'));}}),{headers:{'content-type':'application/pdf'}}));
  try{await assert.rejects(f.manager.download(f.material));const folder=path.join(f.store.settings.downloadDirectory,'Maths--42','Week 1');assert.deepEqual(await readdir(folder),[]);
    const controller=new AbortController();controller.abort();await assert.rejects(f.manager.download(f.material,controller.signal));assert.deepEqual(await readdir(folder),[]);
  }finally{await f.close();}
});
test('redirects to authentication and symbolic-link directories cannot write files',async()=>{
  const f=await fixture(()=>new Response(null,{status:302,headers:{location:'https://uim.xjtlu.edu.cn/login'}}));
  try{
    await assert.rejects(f.manager.download(f.material),{code:'AUTH_REQUIRED'});
    const outside=path.join(f.root,'outside');await mkdir(outside);const course=path.join(f.store.settings.downloadDirectory,'Maths--42');await rm(course,{recursive:true,force:true});await symlink(outside,course);
    await assert.rejects(f.manager.download(f.material),{code:'PATH_DENIED'});assert.deepEqual(await readdir(outside),[]);
  }finally{await f.close();}
});
test('background jobs retain failure details and support retry selection',async()=>{
  const f=await fixture(()=>new Response('failure',{status:500}));
  try{
    const job=await f.manager.start([f.material.id]);await f.manager.shutdown();assert.equal(job.state,'cancelled');
    assert(job.items.some(item=>['cancelled','failed'].includes(item.state)));
    const retry=await f.manager.start([f.material.id],job.id);await f.manager.shutdown();assert.notEqual(job.id,retry.id);
  }finally{await f.close();}
});
