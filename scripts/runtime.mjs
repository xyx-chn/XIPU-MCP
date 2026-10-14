import https from 'node:https';
import { mkdir,writeFile,readFile,chmod,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
function get(url,redirects=0){return new Promise((resolve,reject)=>{
  const request=https.get(url,response=>{
    if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();if(redirects>=4)return reject(new Error('Too many redirects'));const next=new URL(response.headers.location,url);if(next.hostname!=='nodejs.org')return reject(new Error('Unexpected runtime source'));return resolve(get(next.href,redirects+1));}
    if(response.statusCode!==200){response.resume();return reject(new Error(`Node download HTTP ${response.statusCode}`));}
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);
  });request.setTimeout(30_000,()=>request.destroy(new Error('Runtime download timeout')));request.on('error',reject);
});}
const version='v22.23.3';
let hashes;
const choice=process.argv[2]??process.arch;const architectures=choice==='all'?['arm64','x64']:[choice];
for(const arch of architectures){
  if(!['arm64','x64'].includes(arch))throw new Error('Supported macOS architectures: arm64, x64');
  const folder=path.resolve('runtime',arch);await mkdir(folder,{recursive:true});
  try{const metadata=JSON.parse(await readFile(path.join(folder,'metadata.json'),'utf8'));if(metadata.version===version){await readFile(path.join(folder,'node'));await readFile(path.join(folder,'LICENSE'));console.log(`Node ${version} ${arch} already bundled`);continue;}}catch{}
  hashes??=(await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString();
  const filename=`node-${version}-darwin-${arch}.tar.gz`;const expected=hashes.split('\n').find(line=>line.endsWith('  '+filename))?.split(/\s+/)[0];if(!expected)throw new Error('Runtime checksum missing');
  const bytes=await get(`https://nodejs.org/dist/${version}/${filename}`);if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Node runtime checksum mismatch');
  const archive=path.join(folder,filename);await writeFile(archive,bytes);execFileSync('/usr/bin/tar',['-xzf',archive,'--strip-components=2','-C',folder,`node-${version}-darwin-${arch}/bin/node`]);execFileSync('/usr/bin/tar',['-xzf',archive,'--strip-components=1','-C',folder,`node-${version}-darwin-${arch}/LICENSE`]);await chmod(path.join(folder,'node'),0o755);await rm(archive);
  await writeFile(path.join(folder,'metadata.json'),JSON.stringify({version,arch,archiveSha256:expected}));console.log(`Bundled verified Node ${version} ${arch}`);
}
await chmod('scripts/xipu-mcp',0o755);
