import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
test('stdio MCP handshake lists exactly nine bounded tools and exits when stdin closes',async()=>{
  const child=spawn(process.execPath,[path.resolve('build/bridge.cjs')],{stdio:['pipe','pipe','pipe']});let buffer='',errors='';let next=1;
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  child.stderr.on('data',chunk=>errors+=chunk);child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();while(buffer.includes('\n')){const line=buffer.slice(0,buffer.indexOf('\n'));buffer=buffer.slice(buffer.indexOf('\n')+1);let response:any;
      try{response=JSON.parse(line);}catch{for(const p of pending.values())p.reject(new Error('Non-JSON data on MCP stdout'));return;}
      if(response.id!==undefined){const p=pending.get(response.id);if(p){clearTimeout(p.timer);pending.delete(response.id);p.resolve(response);}}
    }
  });
  const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>reject(new Error('MCP request timed out')),10_000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  try{
    const hello=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'xipu-test',version:'1.0'}});assert.equal(hello.result.serverInfo.name,'xipu-mcp');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await request('tools/list',{});assert.equal(list.result.tools.length,9);assert(!list.result.tools.some((t:any)=>/mail|email|password|otp/.test(t.name)));
    const bad=await request('tools/call',{name:'download_materials',arguments:{materialIds:['abc'],directory:'/private'}});assert(bad.error||bad.result?.isError);
    assert.equal(errors,'');
    const exited=new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('MCP did not exit on EOF'));},5000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});child.stdin.end();assert.equal(await exited,0);
  }finally{child.kill();for(const p of pending.values())clearTimeout(p.timer);}
});
