import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { chmod, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, publicError, toolSchemas, type ToolName } from './shared.js';

export const dataDirectory = () => path.join(homedir(),'Library','Application Support','XIPU MCP');
export const socketPath = (directory=dataDirectory()) => path.join(directory,'bridge.sock');
export const tokenPath = (directory=dataDirectory()) => path.join(directory,'bridge.token');
export async function createBroker(directory:string, call:(name:ToolName,args:unknown)=>Promise<unknown>) {
  const file=socketPath(directory);let token:string;
  try{token=(await readFile(tokenPath(directory),'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid token');}
  catch{token=randomBytes(32).toString('hex');await writeFile(tokenPath(directory),token,{mode:0o600});}
  await chmod(tokenPath(directory),0o600);
  try{const stat=await lstat(file);if(!stat.isSocket())throw new AppError('SOCKET_PATH','IPC 路径已存在且不是 socket。');await rm(file);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const connections=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>undefined);
    socket.setTimeout(180_000,()=>socket.destroy());let buffer='';let busy=false;
    socket.on('data',chunk=>{
      buffer+=chunk.toString('utf8');if(buffer.length>1024*1024){socket.destroy();return;}
      if(!buffer.includes('\n'))return;if(busy){socket.destroy();return;}busy=true;
      const line=buffer.slice(0,buffer.indexOf('\n'));buffer='';
      void(async()=>{
        let result:unknown;
        try {
          const request=JSON.parse(line);const candidate=Buffer.from(String(request.token??''));const expected=Buffer.from(token);
          if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected))throw new AppError('IPC_DENIED','本机接口认证失败。');
          if(!(request.method in toolSchemas)||!Object.hasOwn(toolSchemas,request.method))throw new AppError('TOOL_UNKNOWN','不支持该 MCP 工具。');
          const name=request.method as ToolName;const args=toolSchemas[name].strict().parse(request.args??{});
          result={ok:true,result:await call(name,args)};
        }catch(e){result={ok:false,error:publicError(e)};}
        socket.end(JSON.stringify(result)+'\n');
      })();
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(file,()=>{server.off('error',reject);resolve();});});await chmod(file,0o600);
  return async()=>{for(const socket of connections)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(file,{force:true});};
}
export async function brokerRequest(method:ToolName,args:unknown,directory=dataDirectory()):Promise<unknown> {
  const token=(await readFile(tokenPath(directory),'utf8')).trim();
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath(directory));let buffer='';
    socket.setTimeout(190_000,()=>socket.destroy(new Error('IPC timeout')));
    socket.on('connect',()=>socket.write(JSON.stringify({token,method,args})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>10*1024*1024){socket.destroy(new Error('IPC response too large'));return;}
      if(buffer.includes('\n')){try{const payload=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));socket.end();if(!payload.ok)reject(new AppError(payload.error.code,payload.error.message));else resolve(payload.result);}catch(e){reject(e);}}});
    socket.on('error',reject);socket.on('end',()=>{if(!buffer.includes('\n'))reject(new Error('IPC response interrupted'));});
  });
}
