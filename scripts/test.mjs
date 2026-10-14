import { mkdtemp,writeFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
const folder=await mkdtemp(path.join(tmpdir(),'xipu-test-'));
await writeFile(path.join(folder,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
try{
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',path.join(folder,'key.pem'),'-out',path.join(folder,'cert.pem'),'-config',path.join(folder,'openssl.cnf')],{stdio:'ignore'});
  const files=(await readdir('test')).filter(f=>f.endsWith('.test.ts')).map(f=>'test/'+f);
  const child=spawn(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',env:{...process.env,NODE_EXTRA_CA_CERTS:path.join(folder,'cert.pem'),XIPU_TEST_CERT:folder}});
  process.exitCode=await new Promise(resolve=>child.on('exit',code=>resolve(code??1)));
}finally{await rm(folder,{recursive:true,force:true});}
