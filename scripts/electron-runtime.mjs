import { mkdir,readFile,writeFile,access,copyFile,rename,rm,mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const version=JSON.parse(await readFile('node_modules/electron/package.json','utf8')).version;
const checksums=JSON.parse(await readFile('node_modules/electron/checksums.json','utf8'));
const choice=process.argv[2]??process.arch;
for(const arch of choice==='all'?['arm64','x64']:[choice]){
  if(!['arm64','x64'].includes(arch))throw new Error('Unsupported architecture');
  const folder=path.resolve('runtime','electron',arch),cache=path.resolve('runtime','downloads');await mkdir(path.dirname(folder),{recursive:true});await mkdir(cache,{recursive:true});
  const name=`electron-v${version}-darwin-${arch}.zip`,archive=path.join(cache,name);
  if(!/^[a-f0-9]{64}$/.test(checksums[name]??''))throw new Error('Official Electron checksum missing');
  // Migrate an old archive cache, but never trust an extracted App by existence.
  try{await access(archive);}catch{try{await copyFile(path.join(folder,name),archive);}catch{}}
  let verified=false;try{verified=createHash('sha256').update(await readFile(archive)).digest('hex')===checksums[name];}catch{}
  if(!verified){await rm(archive,{force:true});execFileSync('/usr/bin/curl',['--proto','=https','--proto-redir','=https','--fail','--location','--retry','3','--retry-all-errors','--connect-timeout','20','--max-time','600','--silent','--show-error','--output',archive,`https://github.com/electron/electron/releases/download/v${version}/${name}`],{stdio:'inherit'});}
  if(createHash('sha256').update(await readFile(archive)).digest('hex')!==checksums[name])throw new Error('Electron checksum mismatch');
  const stage=await mkdtemp(path.join(path.dirname(folder),'.extract-'));
  try{execFileSync('/usr/bin/unzip',['-q',archive,'-d',stage]);await access(path.join(stage,'Electron.app','Contents','MacOS','Electron'));await rm(folder,{recursive:true,force:true});await rename(stage,folder);}finally{await rm(stage,{recursive:true,force:true});}
  console.log(`Verified Electron ${version} ${arch}`);
}
// Point the npm development launcher at the same verified local runtime.
if(process.platform==='darwin'){
  const target=path.resolve('runtime','electron',process.arch);try{await access(path.join(target,'Electron.app'));const {symlink,lstat,rm}=await import('node:fs/promises');const dist='node_modules/electron/dist';try{if((await lstat(dist)).isSymbolicLink())await rm(dist);}catch{}try{await symlink(target,dist);}catch{}await writeFile('node_modules/electron/path.txt','Electron.app/Contents/MacOS/Electron');}catch{}
}
