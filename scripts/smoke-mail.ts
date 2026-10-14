// Opt-in live check: uses existing Keychain-encrypted settings; never prints credentials or messages.
import {app} from 'electron';
import {Store} from '../src/store.js';
import {dataDirectory} from '../src/broker.js';
import {MailService} from '../src/mail/service.js';
import {publicError} from '../src/shared.js';

for(const key of Object.keys(process.env))if(/^(?:all|https?|ftp)_proxy$|^NODE_USE_ENV_PROXY$/i.test(key))delete process.env[key];
app.setName('XIPU MCP');app.setPath('userData',dataDirectory());
void(async()=>{
  await app.whenReady();const store=new Store(dataDirectory());await store.load();
  const mail=new MailService(store.settings.mail,store.secrets.mailPassword??'');
  const result=await mail.test();
  const baseline=await mail.baseline();
  console.log(JSON.stringify({ok:result.ok,protocol:result.protocol,transport:'direct TCP',baselineRecorded:true,readOnly:baseline.protocol==='imap',mailBodyRead:false}));
  app.exit(0);
})().catch(error=>{console.error(JSON.stringify(publicError(error)));app.exit(1);});
