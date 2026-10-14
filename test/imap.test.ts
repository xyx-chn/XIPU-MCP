import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MailConfig } from '../src/shared.js';
import { MailService } from '../src/mail/service.js';

async function fixture(mode:'tls'|'starttls',rejectTls=false) {
  const root=process.env.XIPU_TEST_CERT!;const options={key:await readFile(path.join(root,'key.pem')),cert:await readFile(path.join(root,'cert.pem'))};const context=tls.createSecureContext(options);
  const transcript:string[]=[];let fresh=false;const sockets=new Set<net.Socket>();
  const header=(personal:boolean)=>`From: ${personal?'friend@personal.example':'auth@xjtlu.edu.cn'}\r\nTo: student@example.net\r\nSubject: Verification code\r\nDate: ${new Date().toUTCString()}\r\n\r\n`;
  const handle=(socket:net.Socket,greeting:boolean)=>{
    sockets.add(socket);socket.on('error',()=>undefined);socket.on('close',()=>sockets.delete(socket));if(greeting)socket.write('* OK Synthetic IMAP ready\r\n');let buffer='';
    const receive=(chunk:Buffer)=>{
      buffer+=chunk.toString();while(buffer.includes('\r\n')) {
        const line=buffer.slice(0,buffer.indexOf('\r\n'));buffer=buffer.slice(buffer.indexOf('\r\n')+2);transcript.push(line);
        const tag=line.split(' ')[0];const cmd=line.slice(tag.length+1);const ok=()=>socket.write(`${tag} OK done\r\n`);
        if(/^CAPABILITY/i.test(cmd)){socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR'+(mode==='starttls'?' STARTTLS':'')+'\r\n');ok();}
        else if(/^STARTTLS/i.test(cmd)){
          if(rejectTls){socket.write(`${tag} NO TLS unavailable\r\n`);continue;}
          ok();socket.off('data',receive);handle(new tls.TLSSocket(socket,{isServer:true,secureContext:context}),false);return;
        }
        else if(/^(AUTHENTICATE|LOGIN)/i.test(cmd))ok();
        else if(/^LIST/i.test(cmd)){socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');ok();}
        else if(/^EXAMINE/i.test(cmd)){socket.write(`* FLAGS (\\Seen)\r\n* ${fresh?3:1} EXISTS\r\n* OK [UIDVALIDITY 99] stable\r\n* OK [UIDNEXT ${fresh?4:2}] next\r\n`);socket.write(`${tag} OK [READ-ONLY] opened\r\n`);}
        else if(/^UID SEARCH/i.test(cmd)){socket.write('* SEARCH'+(fresh?' 2 3':'')+'\r\n');ok();}
        else if(/^UID FETCH/i.test(cmd)){
          const uid=Number(cmd.match(/^UID FETCH (\d+)/i)?.[1]);
          if(/HEADER.FIELDS/i.test(cmd)){const text=header(uid===2);socket.write(`* ${uid} FETCH (UID ${uid} INTERNALDATE "14-Oct-2026 12:00:00 +0800" BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE)] {${Buffer.byteLength(text)}}\r\n${text})\r\n`);}
          else if(/BODYSTRUCTURE/i.test(cmd))socket.write(`* ${uid} FETCH (UID ${uid} RFC822.SIZE 220 BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 32 1 NIL NIL NIL NIL))\r\n`);
          else if(/BODY.PEEK/i.test(cmd)){const text='Your verification code: 123456\r\n';const part=cmd.match(/BODY\.PEEK\[([^\]]*)\]/i)?.[1]??'TEXT';socket.write(`* ${uid} FETCH (UID ${uid} BODY[${part}]<0> {${Buffer.byteLength(text)}}\r\n${text})\r\n`);}
          else socket.write(`${tag} BAD unexpected fetch\r\n`);
          ok();
        }
        else if(/^LOGOUT/i.test(cmd)){socket.write('* BYE\r\n');socket.end(`${tag} OK logout\r\n`);}
        else if(/^NOOP/i.test(cmd))ok();else socket.write(`${tag} BAD unsupported\r\n`);
      }
    };socket.on('data',receive);
  };
  const server=mode==='tls'?tls.createServer(options,s=>handle(s,true)):net.createServer(s=>handle(s,true));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;
  return {config:MailConfig.parse({host:'localhost',port,security:mode,username:'synthetic-user',recipient:'student@example.net'}),transcript,add:()=>{fresh=true;},close:async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
for(const mode of ['tls','starttls'] as const)test(`IMAP ${mode}: read-only baseline and BODY.PEEK never retrieve unrelated mail`,async()=>{
  const f=await fixture(mode);try{
    const service=new MailService(f.config,'synthetic-password');assert.equal((await service.test()).ok,true);
    assert(!f.transcript.some(line=>/FETCH/i.test(line)));
    const baseline=await service.baseline();f.add();assert.equal(await service.waitForCode(baseline),'123456');
    assert(f.transcript.some(line=>/EXAMINE/.test(line)));assert(!f.transcript.some(line=>/\bSELECT\b|\bSTORE\b|\bEXPUNGE\b/.test(line)));
    const bodies=f.transcript.filter(line=>/BODY.PEEK\[/i.test(line)&&!/HEADER.FIELDS/i.test(line));assert.equal(bodies.length,1);assert(/UID FETCH 3/.test(bodies[0]));
  }finally{await f.close();}
});
test('IMAP STARTTLS cannot fall back to sending authentication',async()=>{
  const f=await fixture('starttls',true);try{await assert.rejects(new MailService(f.config,'synthetic-password').test());assert(!f.transcript.some(line=>/AUTHENTICATE|LOGIN/.test(line)));}finally{await f.close();}
});
