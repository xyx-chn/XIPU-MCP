import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import type { BrowserWindow } from 'electron';
import { CORE, SSO } from '../src/shared.js';
import { LOGIN_RETRY_URL, loadSchoolLoginPage, loginFailureDocument, loginLoadMessage } from '../src/auth-navigation.js';

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
class FakeContents extends EventEmitter {
  url = 'about:blank';
  destroyed = false;
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
}
class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  navigation = deferred();
  destroyed = false;
  requested: string[] = [];
  isDestroyed() { return this.destroyed; }
  loadURL(url: string) { this.requested.push(url); return this.navigation.promise; }
  get electron() { return this as unknown as BrowserWindow; }
  complete(url = SSO + '/esc-sso/login/page') { this.webContents.url = url; this.webContents.emit('did-finish-load'); }
  close() { this.destroyed = true; this.emit('closed'); }
}
function clean(win: FakeWindow, signal: AbortSignal) {
  assert.equal(win.listenerCount('closed'), 0);
  for (const event of ['did-finish-load', 'did-fail-load', 'render-process-gone']) assert.equal(win.webContents.listenerCount(event), 0, event);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('load cancellation during school redirect waits for the final school document and cleans up', async () => {
  const win = new FakeWindow(), controller = new AbortController();
  const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200);
  win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', CORE + '/login/index.php', true);
  win.navigation.reject(Object.assign(new Error('ERR_ABORTED (-3) loading https://secret.example/?token=private'), { code: 'ERR_ABORTED', errno: -3 }));
  await Promise.resolve();
  assert.equal(win.webContents.listenerCount('did-finish-load'), 1);
  win.complete();
  await result;
  assert.deepEqual(win.requested, [CORE + '/login/index.php']);
  clean(win, controller.signal);
});

test('a normal loadURL completion succeeds only for a school document', async () => {
  const win = new FakeWindow(), controller = new AbortController();
  const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200);
  win.webContents.url = CORE + '/my/';
  win.navigation.resolve();
  await result;
  clean(win, controller.signal);
});

test('main-frame errors settle with a numeric safe message; subresource failures do not', async () => {
  const win = new FakeWindow(), controller = new AbortController();
  const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200);
  win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED secret', 'https://sso.invalid/?token=private', false);
  assert.equal(win.webContents.listenerCount('did-finish-load'), 1);
  win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED secret', 'https://sso.invalid/?token=private', true);
  await assert.rejects(result, error => loginLoadMessage(error) === '学校登录页面加载失败（错误码 -105），请检查网络和代理后重新加载。');
  clean(win, controller.signal);
  win.navigation.reject(new Error('late rejection with private URL'));
  await Promise.resolve();
});

test('loadURL rejection without a load event ends instead of leaving a blank window pending', async () => {
  const win = new FakeWindow(), controller = new AbortController();
  const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200);
  win.navigation.reject(new Error('ERR_CONNECTION_REFUSED (-102) loading https://private.example/?token=secret'));
  await assert.rejects(result, error => loginLoadMessage(error).includes('错误码 -102') && !loginLoadMessage(error).includes('secret'));
  clean(win, controller.signal);
});

test('blank, browser-error and unrelated final pages are rejected', async () => {
  for (const url of ['about:blank', 'chrome-error://chromewebdata/', 'https://other.example/', 'https://core.xjtlu.edu.cn.other.example/', 'https://user:password@core.xjtlu.edu.cn/my/']) {
    const win = new FakeWindow(), controller = new AbortController();
    const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200);
    win.complete(url);
    await assert.rejects(result, error => loginLoadMessage(error).includes('未允许'));
    clean(win, controller.signal);
  }
});

test('an unknown initial origin is refused before loading', async () => {
  const win = new FakeWindow(), controller = new AbortController();
  await assert.rejects(loadSchoolLoginPage(win.electron, 'https://other.example/', controller.signal, 200));
  assert.deepEqual(win.requested, []);
  clean(win, controller.signal);
});

test('cancel, close and renderer loss end pending navigation and remove all listeners', async () => {
  for (const action of ['abort', 'close', 'renderer'] as const) {
    const win = new FakeWindow(), controller = new AbortController();
    const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200);
    if (action === 'abort') controller.abort();
    else if (action === 'close') win.close();
    else win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await assert.rejects(result);
    clean(win, controller.signal);
    win.navigation.reject(new Error('late failure'));
    await Promise.resolve();
  }
});

test('already cancelled or closed windows never start loading', async () => {
  for (const kind of ['abort', 'close']) {
    const win = new FakeWindow(), controller = new AbortController();
    if (kind === 'abort') controller.abort(); else win.close();
    await assert.rejects(loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 200));
    assert.deepEqual(win.requested, []);
    clean(win, controller.signal);
  }
});

test('an aborted navigation without a replacement times out rather than hanging forever', async () => {
  const win = new FakeWindow(), controller = new AbortController();
  const result = loadSchoolLoginPage(win.electron, CORE + '/login/index.php', controller.signal, 10);
  win.navigation.reject(Object.assign(new Error('aborted'), { errno: -3 }));
  await assert.rejects(result, error => loginLoadMessage(error).includes('加载超时'));
  clean(win, controller.signal);
});

test('the visible failure document contains a safe retry link, strict CSP and escaped message', () => {
  const html = loginFailureDocument('<img src=x onerror="alert(1)"> & \'secret\'');
  assert(html.includes('学校登录页面未能加载'));
  assert(html.includes(`href="${LOGIN_RETRY_URL}"`));
  assert(html.includes('重新加载'));
  assert(html.includes("default-src 'none'"));
  assert(html.includes("script-src 'none'"));
  assert(html.includes("form-action 'none'"));
  assert(html.includes('color-scheme:light dark'));
  assert(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;secret&#39;'));
  assert(!html.includes('<img'));
  assert(!html.includes('<script'));
  assert(!loginLoadMessage(new Error('https://private.example/?token=secret')).includes('secret'));
});
