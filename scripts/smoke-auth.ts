// Development-only live check. Uses existing encrypted configuration; prints no secrets.
import {app} from 'electron';
import {Store} from '../src/store.js';
import {AuthService} from '../src/auth.js';
import {dataDirectory} from '../src/broker.js';
import {CORE} from '../src/shared.js';
app.setName('XIPU MCP');app.setPath('userData',dataDirectory());
void(async()=>{
  await app.whenReady();const store=new Store(dataDirectory());await store.load();
  const auth=new AuthService(store,()=>undefined);await auth.restore();
  if(auth.status.state!=='authenticated')throw new Error('Saved session was not usable');
  console.log(JSON.stringify({restored:true}));
  // Remove only this test process's in-memory Moodle cookie. SSO cookies remain available.
  await auth.session.cookies.remove(CORE,'MoodleSession');auth.invalidate();
  await auth.connect(false);
  console.log(JSON.stringify({automaticRelogin:auth.status.state==='authenticated',state:auth.status.state}));
  app.exit(auth.status.state==='authenticated'?0:1);
})().catch(()=>{console.error('Live session check did not complete; check the school login window.');app.exit(1);});
