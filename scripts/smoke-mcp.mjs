import { spawn } from 'node:child_process';
const command=process.argv[2];if(!command)throw new Error('Usage: node scripts/smoke-mcp.mjs <absolute MCP launcher path>');
const child=spawn(command,[],{stdio:['pipe','pipe','pipe']});let buffer='',id=0;const pending=new Map();
child.stderr.on('data',chunk=>process.stderr.write(chunk));
child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const line=buffer.slice(0,buffer.indexOf('\n'));buffer=buffer.slice(buffer.indexOf('\n')+1);const response=JSON.parse(line);const entry=pending.get(response.id);if(entry){clearTimeout(entry.timer);pending.delete(response.id);entry.resolve(response);}}});
const request=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>reject(new Error('MCP smoke timeout')),45_000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
try{
  const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'xipu-smoke',version:'1.0'}});
  if(init.error)throw new Error('MCP initialization failed');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await request('tools/list',{});if(tools.result?.tools?.length!==9)throw new Error('Unexpected tool count');
  const status=await request('tools/call',{name:'auth_status',arguments:{}});if(status.error||status.result?.isError)throw new Error('App broker connection failed');
  const payload=status.result.structuredContent??JSON.parse(status.result.content[0].text);
  console.log(JSON.stringify({server:init.result.serverInfo.name,version:init.result.serverInfo.version,toolCount:tools.result.tools.length,brokerConnected:true,schoolState:payload.state}));
  if(process.argv.includes('--live')){
    const response=await request('tools/call',{name:'list_courses',arguments:{}});
    if(response.error||response.result?.isError)throw new Error('Live course tool failed');
    const courses=response.result.structuredContent?.result??JSON.parse(response.result.content[0].text);
    console.log(JSON.stringify({liveCourseCount:courses.length}));
    const deadlineResponse=await request('tools/call',{name:'list_deadlines',arguments:{}});
    if(deadlineResponse.error||deadlineResponse.result?.isError)throw new Error('Live deadline tool failed');
    const dates=deadlineResponse.result.structuredContent??JSON.parse(deadlineResponse.result.content[0].text);
    console.log(JSON.stringify({liveDeadlineCount:dates.deadlines.length,warnings:dates.warnings}));
  }
  const materialCheck=process.argv.find(arg=>/^--materials=\d+$/.test(arg));
  if(materialCheck){
    const courseId=materialCheck.split('=')[1];
    const response=await request('tools/call',{name:'list_materials',arguments:{courseIds:[courseId]}});
    if(response.error||response.result?.isError)throw new Error('Live material tool failed');
    const materials=response.result.structuredContent?.result??JSON.parse(response.result.content[0].text);
    console.log(JSON.stringify({courseId,liveFiles:materials.filter(m=>m.kind==='file').length,liveLinks:materials.filter(m=>m.kind==='link').length}));
  }
}finally{for(const entry of pending.values())clearTimeout(entry.timer);child.stdin.end();}
