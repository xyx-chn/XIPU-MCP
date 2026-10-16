import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AuthService } from '../src/auth.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = 0;
  focused = 0;
  isDestroyed() { return this.destroyed; }
  show() { this.shown++; }
  focus() { this.focused++; }
  close() { this.destroyed = true; this.emit('closed'); }
}

// Bypass Electron construction: no real windows, cookies, files or school
// requests are needed to exercise the authentication lifecycle.
function service() {
  const auth = Object.create(AuthService.prototype) as any;
  Object.assign(auth, {
    windowLoadFailed: false, lastChecked: 0, lastFailed: 0,
    status: { state: 'signed_out', message: 'test', checkedAt: new Date().toISOString() },
    changed: () => undefined,
    session: { clearStorageData: async () => undefined },
    store: { settings: { username: 'test-account' }, clearSecrets: async () => undefined },
  });
  return auth;
}

test('manual connection focuses a healthy window and concurrent connections share one run', async () => {
  const auth = service(), window = new FakeWindow(), flight = deferred<void>();
  let runs = 0;
  auth.window = window;
  auth.run = async () => { runs++; await flight.promise; };
  await auth.connect(true);
  assert.equal(window.shown, 1);
  assert.equal(window.focused, 1);
  assert.equal(runs, 0);
  auth.window = undefined;
  const first = auth.connect(false), pending = auth.pending;
  const second = auth.connect(false);
  assert.equal(auth.pending, pending);
  assert.equal(runs, 1);
  flight.resolve();
  await Promise.all([first, second]);
  assert.equal(auth.pending, undefined);
});

test('a failed-page retry starts immediately while the old probe is still pending', async () => {
  const auth = service(), oldFlight = deferred<void>(), newFlight = deferred<void>();
  const controllers: AbortController[] = [];
  auth.run = async (_manual: boolean, controller: AbortController) => {
    controllers.push(controller);
    await (controllers.length === 1 ? oldFlight : newFlight).promise;
  };
  const first = auth.connect(false);
  const oldWindow = new FakeWindow();
  auth.window = oldWindow;
  auth.windowLoadFailed = true;
  const retry = auth.connect(true), newPending = auth.pending;
  try {
    assert.equal(controllers.length, 2, 'Retry must not wait for the old network probe');
    assert.equal(controllers[0].signal.aborted, true);
    assert.equal(controllers[1].signal.aborted, false);
    assert.equal(oldWindow.destroyed, true);
    oldFlight.resolve();
    await first;
    assert.equal(auth.pending, newPending, 'An old finally must not clear the new pending run');
  } finally {
    oldFlight.resolve();
    newFlight.resolve();
    await Promise.all([first, retry]);
  }
  assert.equal(auth.pending, undefined);
});

test('clearing cancels the old run and allows a new connection before it settles', async () => {
  const auth = service(), oldFlight = deferred<void>(), newFlight = deferred<void>();
  const controllers: AbortController[] = [];
  auth.run = async (_manual: boolean, controller: AbortController) => {
    controllers.push(controller);
    await (controllers.length === 1 ? oldFlight : newFlight).promise;
  };
  const first = auth.connect(false);
  await auth.clear();
  assert.equal(controllers[0].signal.aborted, true);
  assert.equal(auth.pending, undefined);
  const second = auth.connect(false), newPending = auth.pending;
  try {
    assert.equal(controllers.length, 2);
    oldFlight.resolve();
    await first;
    assert.equal(auth.pending, newPending);
  } finally {
    oldFlight.resolve();
    newFlight.resolve();
    await Promise.all([first, second]);
  }
});

test('an old successful probe cannot authenticate after cancellation or replacement', async () => {
  for (const action of ['clear', 'replace'] as const) {
    const auth = service(), probe = deferred<boolean>(), controller = new AbortController();
    auth.controller = controller;
    auth.probe = () => probe.promise;
    const run = auth.run(true, controller);
    if (action === 'clear') await auth.clear();
    else auth.controller = new AbortController();
    probe.resolve(true);
    await run;
    assert.equal(auth.status.state, 'signed_out', action);
    assert.equal(auth.lastChecked, 0, action);
  }
});

test('a stale manual watcher ignores a successful probe and does not overlap checks', async t => {
  let tick!: () => Promise<void>;
  t.mock.method(globalThis, 'setInterval', ((callback: () => Promise<void>) => {
    tick = callback;
    return { unref() {} };
  }) as unknown as typeof setInterval);
  t.mock.method(globalThis, 'clearInterval', () => undefined);
  const auth = service(), window = new FakeWindow(), probe = deferred<boolean>();
  const controller = new AbortController();
  let probes = 0, saves = 0;
  auth.window = window;
  auth.controller = controller;
  auth.probe = () => { probes++; return probe.promise; };
  auth.persist = async () => { saves++; return true; };
  auth.watchManual(window, controller);
  const checking = tick();
  await tick();
  assert.equal(probes, 1);
  auth.controller = new AbortController();
  probe.resolve(true);
  await checking;
  assert.equal(saves, 0);
  assert.equal(window.destroyed, false);
  assert.equal(auth.status.state, 'signed_out');
});

test('a redirect-loop error presents local recovery and its retry starts a new login', async () => {
  const auth=service(), window=new FakeWindow(), controller=new AbortController();
  const documents:string[]=[];
  Object.assign(window,{loadURL:async(url:string)=>{documents.push(url);}});
  auth.window=window;auth.controller=controller;
  await auth.showLoadFailure(window,controller,{reason:'load_failed',errorCode:-310});
  assert.equal(auth.resetSessionOnRetry,true);
  assert.equal(auth.windowLoadFailed,true);
  assert.match(auth.status.message,/循环跳转/);
  assert.equal(documents.length,1);
  assert(documents[0].startsWith('data:text/html;'));
  assert(decodeURIComponent(documents[0]).includes('xipu-login://retry'));
  let runs=0;
  auth.run=async(manual:boolean,newController:AbortController)=>{
    runs++;assert.equal(manual,true);assert.notEqual(newController,controller);
    assert.equal(newController.signal.aborted,false);
  };
  await auth.connect(true);
  assert.equal(runs,1);
  assert.equal(controller.signal.aborted,true);
  assert.equal(window.destroyed,true);
});

test('cookies finishing after cancellation cannot overwrite saved account state', async () => {
  const auth=service(), cookies=deferred<unknown[]>(), controller=new AbortController();
  const secrets={schoolPassword:'synthetic',cookies:[]};let writes=0;
  auth.store.secrets=secrets;
  auth.store.saveSecrets=async()=>{writes++;};
  auth.session.cookies={get:()=>cookies.promise};
  const persist=auth.persist(()=>!controller.signal.aborted);
  controller.abort();cookies.resolve([{domain:'core.xjtlu.edu.cn',name:'MoodleSession',value:'synthetic'}]);
  assert.equal(await persist,false);
  assert.equal(auth.store.secrets,secrets);
  assert.deepEqual(auth.store.secrets.cookies,[]);
  assert.equal(writes,0);
});

test('a manual login can retry saving its session after a transient storage failure', async t => {
  let tick!:()=>Promise<void>, cleared=0;
  t.mock.method(globalThis,'setInterval',((callback:()=>Promise<void>)=>{tick=callback;return {unref(){}};}) as unknown as typeof setInterval);
  t.mock.method(globalThis,'clearInterval',()=>{cleared++;});
  const auth=service(),window=new FakeWindow(),controller=new AbortController();let saves=0;
  auth.window=window;auth.controller=controller;auth.probe=async()=>true;
  auth.persist=async()=>{if(++saves===1)throw new Error('temporary storage failure');return true;};
  auth.watchManual(window,controller);
  await tick();
  assert.equal(cleared,0);assert.equal(window.destroyed,false);assert.equal(auth.status.state,'needs_user');
  await tick();
  assert.equal(saves,2);assert.equal(auth.status.state,'authenticated');assert.equal(window.destroyed,true);
  assert(cleared>0);
});
