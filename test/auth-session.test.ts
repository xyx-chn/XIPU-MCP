import test from 'node:test';
import assert from 'node:assert/strict';
import type { Cookie, Session } from 'electron';
import { resetSchoolLoginCookies } from '../src/auth-session.js';

function cookie(domain: string, path = '/', name = 'session'): Cookie {
  const fixture = { domain, path, name };
  // A reset must never inspect, copy, log or serialize credential values.
  Object.defineProperty(fixture, 'value', { get() { throw new Error('Cookie value must not be accessed'); } });
  return fixture as Cookie;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(cookies: Cookie[], overrides: { get?: () => Promise<Cookie[]>; remove?: (url: string, name: string) => Promise<void> } = {}) {
  const removals: [string, string][] = [], queries: unknown[] = [];
  const session = { cookies: {
    get: async (filter: unknown) => { queries.push(filter); return overrides.get ? overrides.get() : cookies; },
    remove: async (url: string, name: string) => { removals.push([url, name]); await overrides.remove?.(url, name); },
  } } as unknown as Pick<Session, 'cookies'>;
  return { session, removals, queries };
}

test('only the three exact school domains are reset, including domain cookies', async () => {
  const f = fixture([
    cookie('core.xjtlu.edu.cn'), cookie('.uim.xjtlu.edu.cn'), cookie('.xjtlu.edu.cn'), cookie('CORE.XJTLU.EDU.CN', '/upper', 'upper'),
    cookie('other.example'), cookie('mail.xjtlu.edu.cn'), cookie('core.xjtlu.edu.cn.evil.example'), cookie('notxjtlu.edu.cn'),
  ]);
  await resetSchoolLoginCookies(f.session, new AbortController().signal);
  assert.deepEqual(f.queries, [{}]);
  assert.deepEqual(f.removals, [
    ['https://core.xjtlu.edu.cn/', 'session'], ['https://uim.xjtlu.edu.cn/', 'session'],
    ['https://xjtlu.edu.cn/', 'session'], ['https://core.xjtlu.edu.cn/upper', 'upper'],
  ]);
});

test('same-name cookies use their individual domain and path, with no query or fragment injection', async () => {
  const f = fixture([
    cookie('core.xjtlu.edu.cn', '/', 'shared'), cookie('.core.xjtlu.edu.cn', '/auth/saml2/', 'shared'),
    cookie('uim.xjtlu.edu.cn', '/esc-sso/', 'shared'), cookie('core.xjtlu.edu.cn', '/path?literal#fragment', 'odd-path'),
  ]);
  await resetSchoolLoginCookies(f.session, new AbortController().signal);
  assert.deepEqual(f.removals, [
    ['https://core.xjtlu.edu.cn/', 'shared'], ['https://core.xjtlu.edu.cn/auth/saml2/', 'shared'],
    ['https://uim.xjtlu.edu.cn/esc-sso/', 'shared'], ['https://core.xjtlu.edu.cn/path%3Fliteral%23fragment', 'odd-path'],
  ]);
});

test('already cancelled reset does not read or delete cookies', async () => {
  const f = fixture([cookie('core.xjtlu.edu.cn')]), controller = new AbortController();
  controller.abort();
  await assert.rejects(resetSchoolLoginCookies(f.session, controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.removals, []);
});

test('cancellation while listing prevents all deletion', async () => {
  const listed = deferred<Cookie[]>(), controller = new AbortController();
  const f = fixture([], { get: () => listed.promise });
  const reset = resetSchoolLoginCookies(f.session, controller.signal);
  controller.abort();
  listed.resolve([cookie('core.xjtlu.edu.cn')]);
  await assert.rejects(reset, { name: 'AbortError' });
  assert.deepEqual(f.removals, []);
});

test('cancellation during a deletion stops before the next cookie', async () => {
  const deleting = deferred<void>(), started = deferred<void>(), controller = new AbortController();
  const f = fixture([cookie('core.xjtlu.edu.cn'), cookie('uim.xjtlu.edu.cn')], { remove: async () => { started.resolve(); await deleting.promise; } });
  const reset = resetSchoolLoginCookies(f.session, controller.signal);
  await started.promise;
  controller.abort();
  deleting.resolve();
  await assert.rejects(reset, { name: 'AbortError' });
  assert.deepEqual(f.removals, [['https://core.xjtlu.edu.cn/', 'session']]);
});

test('list and remove failures propagate instead of reporting a successful reset', async () => {
  const listingFailure = new Error('List failed'), removalFailure = new Error('Removal failed');
  const listing = fixture([], { get: async () => { throw listingFailure; } });
  await assert.rejects(resetSchoolLoginCookies(listing.session, new AbortController().signal), error => error === listingFailure);
  assert.deepEqual(listing.removals, []);
  const removal = fixture([cookie('core.xjtlu.edu.cn'), cookie('uim.xjtlu.edu.cn')], { remove: async () => { throw removalFailure; } });
  await assert.rejects(resetSchoolLoginCookies(removal.session, new AbortController().signal), error => error === removalFailure);
  assert.deepEqual(removal.removals, [['https://core.xjtlu.edu.cn/', 'session']]);
});
