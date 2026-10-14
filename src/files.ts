import { mkdir,rename,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function atomicJson(file:string,value:unknown) {
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);}finally{await rm(temp,{force:true});}
}
