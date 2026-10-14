import { extractDocument } from './documents.js';
import { publicError } from './shared.js';
process.parentPort?.on('message',async event=>{
  try{const result=await extractDocument(new Uint8Array(event.data.bytes),event.data.name);process.parentPort!.postMessage({ok:true,result});}
  catch(e){process.parentPort!.postMessage({ok:false,error:publicError(e)});}
});
