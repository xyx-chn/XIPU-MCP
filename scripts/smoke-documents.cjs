const {app,utilityProcess}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
app.whenReady().then(async()=>{
  const file=process.argv[2];
  const workerPath=process.argv[3]||path.join(__dirname,'../build/documents-worker.cjs');
  const worker=utilityProcess.fork(workerPath,[],{stdio:'pipe'});
  worker.stderr.on('data',chunk=>process.stderr.write(chunk));
  worker.on('message',message=>{
    console.log(JSON.stringify(message.ok?{ok:true,pages:message.result.sections.length,characters:message.result.sections.reduce((n,s)=>n+s.text.length,0),warning:message.result.warning}:message));
    worker.kill();app.exit(message.ok?0:1);
  });
  worker.on('exit',code=>{if(code!==0)app.exit(1);});
  setTimeout(()=>{worker.kill();app.exit(2);},45000).unref();
  worker.postMessage({bytes:new Uint8Array(await fs.readFile(file)),name:path.basename(file)});
}).catch(()=>app.exit(1));
