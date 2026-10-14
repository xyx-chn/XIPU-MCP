// Development-only live adapter diagnostics. Prints resource metadata, never page HTML or secrets.
import {app} from 'electron';
import {Store} from '../src/store.js';
import {AuthService} from '../src/auth.js';
import {MoodleClient} from '../src/moodle/client.js';
import {parseActivities,parseFiles,schoolUrl} from '../src/moodle/parsers.js';
import {dataDirectory} from '../src/broker.js';
import {publicError} from '../src/shared.js';
app.setName('XIPU MCP');app.setPath('userData',dataDirectory());
void(async()=>{
  await app.whenReady();const store=new Store(dataDirectory());await store.load();store.saveSecrets=async()=>undefined;
  const auth=new AuthService(store,()=>undefined);await auth.restore();
  const moodle=new MoodleClient(auth.transport,()=>auth.ensure());await moodle.listCourses();
  for(const courseId of process.argv.slice(2)) {
    const course=moodle.courses.get(courseId);if(!course)continue;
    const html=await moodle.html(course.url),activities=parseActivities(html,courseId);
    console.log(JSON.stringify({courseId,activityCount:activities.length,types:activities.reduce<Record<string,number>>((r,a)=>(r[a.type]=(r[a.type]??0)+1,r),{})}));
    const resources=activities.filter(a=>a.type==='resource');
    const samples=[...new Map([...resources.slice(0,3),...resources.filter(a=>/how to define|week ?[12]|introduction/i.test(a.name)).slice(0,3)].map(a=>[a.id,a])).values()];
    for(const activity of samples) {
      const response=await auth.transport.fetch(activity.url,{redirect:'manual'});
      const location=response.headers.get('location');const safe=location&&schoolUrl(location,activity.url);
      let files:unknown[]=[];
      if(response.ok&&/text\/html/.test(response.headers.get('content-type')??''))files=parseFiles(await response.text(),activity).map(f=>({name:f.name,url:f.url}));
      else await response.body?.cancel();
      console.log(JSON.stringify({activity:activity.name,section:activity.section,url:activity.url,status:response.status,type:response.headers.get('content-type'),location:safe&&!new URL(safe).pathname.startsWith('/auth/')?safe:undefined,files}));
    }
  }
  app.exit(0);
})().catch(e=>{console.error(JSON.stringify(publicError(e)));app.exit(1);});
