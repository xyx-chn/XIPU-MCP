import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MailConfig } from '../src/shared.js';
import { Pop3Client } from '../src/mail/pop3.js';
import { MailService } from '../src/mail/service.js';

async function popFixture(mode:'tls'|'starttls',options:{top?:boolean;rejectStarttls?:boolean;rejectPassword?:boolean}={}) {
  const root=process.env.XIPU_TEST_CERT!;
  const secureContext=tls.createSecureContext({key:await readFile(path.join(root,'key.pem')),cert:await readFile(path.join(root,'cert.pem'))});
  const transcript:string[]=[];let fresh=false;const sockets=new Set<net.Socket>();
  const header=(sender:string)=>`From: ${sender}\r\nTo: student@example.net\r\nSubject: Verification code\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
  const handle=(socket:net.Socket,greeting:boolean)=>{
    sockets.add(socket);socket.on('error',()=>undefined);socket.on('close',()=>sockets.delete(socket));if(greeting)socket.write('+OK ready\r\n');let buffer='';
    const receive=(chunk:Buffer)=>{
      buffer+=chunk.toString();while(buffer.includes('\r\n')){
        const line=buffer.slice(0,buffer.indexOf('\r\n'));buffer=buffer.slice(buffer.indexOf('\r\n')+2);transcript.push(line);
        const command=line.split(' ')[0];
        if(command==='STLS'){
          if(options.rejectStarttls){socket.write('-ERR TLS unavailable\r\n');continue;}
          socket.write('+OK upgrade\r\n');socket.off('data',receive);handle(new tls.TLSSocket(socket,{isServer:true,secureContext}),false);return;
        }
        if(command==='CAPA')socket.write('+OK capabilities\r\nUIDL\r\n'+(options.top===false?'':'TOP\r\n')+'.\r\n');
        else if(command==='USER')socket.write('+OK\r\n');
        else if(command==='PASS')socket.write(options.rejectPassword?'-ERR auth failed\r\n':'+OK\r\n');
        else if(command==='UIDL')socket.write('+OK\r\n1 old\r\n'+(fresh?'2 personal\r\n3 new-code\r\n':'')+'.\r\n');
        else if(command==='TOP'){const number=Number(line.split(' ')[1]);socket.write(options.top===false?'-ERR unsupported\r\n':'+OK\r\n'+header(number===2?'someone@personal.example':'auth@xjtlu.edu.cn')+'\r\n.\r\n');}
        else if(command==='LIST')socket.write('+OK 3 180\r\n');
        else if(command==='RETR')socket.write('+OK\r\n'+header('auth@xjtlu.edu.cn')+'\r\nYour verification code: 123456\r\n.\r\n');
        else if(command==='QUIT')socket.end('+OK bye\r\n');
        else socket.write('-ERR unknown\r\n');
      }
    };socket.on('data',receive);
  };
  const server=mode==='tls'?tls.createServer({secureContext,key:await readFile(path.join(root,'key.pem')),cert:await readFile(path.join(root,'cert.pem'))},s=>handle(s,true)):net.createServer(s=>handle(s,true));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;
  const config=MailConfig.parse({protocol:'pop3',host:'localhost',port,security:mode,username:'synthetic-user',recipient:'student@example.net'});
  return {config,transcript,add:()=>{fresh=true;},close:async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
for(const mode of ['tls','starttls'] as const)test(`POP3 ${mode}: tests no body, filters new headers, retrieves only matching message`,async()=>{
  const fixture=await popFixture(mode);try {
    const service=new MailService(fixture.config,'synthetic-password');assert.equal((await service.test()).ok,true);assert(!fixture.transcript.some(c=>c.startsWith('RETR')));
    const baseline=await service.baseline();fixture.add();assert.equal(await service.waitForCode(baseline),'123456');
    assert.deepEqual(fixture.transcript.filter(c=>c.startsWith('RETR')),['RETR 3']);assert(!fixture.transcript.some(c=>c.startsWith('DELE')));
    if(mode==='starttls')assert(fixture.transcript.indexOf('STLS')<fixture.transcript.findIndex(c=>c.startsWith('USER')));
  }finally{await fixture.close();}
});
test('POP3 missing TOP fails closed without downloading bodies',async()=>{
  const f=await popFixture('tls',{top:false});try{await assert.rejects(new MailService(f.config,'synthetic').test());assert(!f.transcript.some(c=>c.startsWith('RETR')));}finally{await f.close();}
});
test('POP3 STARTTLS rejection never sends credentials',async()=>{
  const f=await popFixture('starttls',{rejectStarttls:true});try{const client=new Pop3Client(f.config,'synthetic');await assert.rejects(client.connect());await client.close();assert(!f.transcript.some(c=>/^(USER|PASS)/.test(c)));}finally{await f.close();}
});
test('POP3 wrong credentials do not fetch messages',async()=>{
  const f=await popFixture('tls',{rejectPassword:true});try{await assert.rejects(new MailService(f.config,'synthetic').test());assert(!f.transcript.some(c=>/^(TOP|RETR)/.test(c)));}finally{await f.close();}
});
