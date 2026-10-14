import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createBroker,brokerRequest,socketPath,tokenPath } from '../src/broker.js';

test('IPC shares one broker, requires a token, limits tools and protects socket permissions',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'xipu-ipc-'));let calls=0;
  const close=await createBroker(dir,async(method)=>{calls++;return{state:'authenticated',method};});
  try{
    const result:any=await brokerRequest('auth_status',{},dir);assert.equal(result.state,'authenticated');
    assert.equal((await stat(tokenPath(dir))).mode&0o777,0o600);assert.equal((await stat(socketPath(dir))).mode&0o777,0o600);
    await Promise.all([brokerRequest('list_courses',{},dir),brokerRequest('auth_status',{},dir)]);assert.equal(calls,3);
    const send=(request:unknown)=>new Promise<any>((resolve,reject)=>{const s=net.createConnection(socketPath(dir));let b='';s.on('connect',()=>s.write(JSON.stringify(request)+'\n'));s.on('data',c=>b+=c);s.on('end',()=>resolve(JSON.parse(b)));s.on('error',reject);});
    const denied=await send({token:'bad',method:'auth_status',args:{}});assert.equal(denied.error.code,'IPC_DENIED');assert.equal(calls,3);
  }finally{await close();await rm(dir,{recursive:true,force:true});}
});
