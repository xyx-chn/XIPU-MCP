import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeadlineService, type DeadlineFetchResult } from '../src/deadline-service.js';
import { AuthService } from '../src/auth.js';
import { AppError, CORE, type AuthStatus, type Course, type Deadline } from '../src/shared.js';

const observedAt = '2026-10-14T03:00:00.000Z';
const course: Course = { id: '42', name: 'COS305 Software Engineering', shortName: 'COS305', url: CORE + '/course/view.php?id=42' };
function deadline(id = 'due', at = '2026-10-16T15:59:00.000Z'): Deadline {
  return { id, courseId: course.id, name: 'Report ' + id, kind: 'assignment_due', at, timezone: 'Asia/Shanghai', url: CORE + '/mod/assign/view.php?id=7', observedAt, source: 'moodle', submissionStatus: 'No submissions have been made yet' };
}
function result(deadlines = [deadline()], warnings: string[] = []): DeadlineFetchResult {
  return { courses: [course], deadlines, warnings, observedAt };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function directory(t: TestContext) {
  const folder = await mkdtemp(path.join(tmpdir(), 'xipu-deadlines-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}
function service(t: TestContext, folder: string, overrides: Partial<ConstructorParameters<typeof DeadlineService>[0]> = {}) {
  const instance = new DeadlineService({ directory: folder, fetch: async () => result(), authState: () => 'authenticated', changed: () => undefined, ...overrides });
  t.after(() => instance.dispose());
  return instance;
}
async function cached(folder: string) { return JSON.parse(await readFile(path.join(folder, 'snapshot.json'), 'utf8')); }

test('cold start and restart retain only the public deadline snapshot with private file permissions', async t => {
  const folder = await directory(t), first = service(t, folder);
  await first.load();
  assert.equal(first.snapshot.lastSuccessfulSyncAt, null);
  assert.equal(first.snapshot.connectionState, 'connected');
  assert.deepEqual(first.snapshot.deadlines, []);
  const withSecrets = { ...deadline(), password: 'deadline-password', cookies: ['cookie-value'], diagnostic: { token: 'token-value' } } as Deadline;
  const privateCourse = { ...course, username: 'student-private', schoolPassword: 'school-private' } as Course;
  await first.accept(result([withSecrets]), [privateCourse], first.captureGeneration());
  const stored = await readFile(path.join(folder, 'snapshot.json'), 'utf8');
  for (const secret of ['deadline-password', 'cookie-value', 'token-value', 'student-private', 'school-private']) assert(!stored.includes(secret));
  assert.deepEqual(Object.keys(first.snapshot.courses[0]).sort(), ['id', 'name', 'shortName']);
  assert.equal((await stat(path.join(folder, 'snapshot.json'))).mode & 0o777, 0o600);
  const restarted = service(t, folder, { authState: () => 'signed_out' });
  await restarted.load();
  assert.equal(restarted.snapshot.lastSuccessfulSyncAt, observedAt);
  assert.equal(restarted.snapshot.connectionState, 'login_required');
  assert.deepEqual(restarted.snapshot.deadlines, [deadline()]);
  const detached = restarted.snapshot;
  detached.deadlines[0].name = 'Modified by renderer';
  detached.warnings.push('Injected warning');
  assert.equal(restarted.snapshot.deadlines[0].name, deadline().name);
  assert.deepEqual(restarted.snapshot.warnings, []);
});

test('malformed, unknown-version, excessive and unsafe-source caches recover to an empty snapshot', async t => {
  const folder = await directory(t), instance = service(t, folder, { authState: () => 'unconfigured' });
  const valid = { version: 1, courses: [course], deadlines: [deadline()], warnings: [], connectionState: 'connected', lastSuccessfulSyncAt: observedAt };
  const bad = [
    '{broken-json',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, deadlines: [{ ...deadline(), url: 'https://evil.example/credential' }] }),
    JSON.stringify({ ...valid, deadlines: [{ ...deadline(), at: 'not-a-date' }] }),
    ' '.repeat(2 * 1024 * 1024 + 1),
  ];
  for (const value of bad) {
    await writeFile(path.join(folder, 'snapshot.json'), value);
    await instance.load();
    assert.deepEqual(instance.snapshot.deadlines, []);
    assert.equal(instance.snapshot.lastSuccessfulSyncAt, null);
    assert.equal(instance.snapshot.connectionState, 'unconfigured');
    assert.deepEqual(await cached(folder), instance.snapshot);
  }
});

test('partial Moodle warnings persist alongside successful data rather than becoming an empty healthy state', async t => {
  const folder = await directory(t), warnings = ['学校日历 AJAX 未开放；已读取作业和测验页面。'];
  const instance = service(t, folder, { fetch: async () => result([], warnings) });
  await instance.refresh();
  assert.deepEqual(instance.snapshot.deadlines, []);
  assert.deepEqual(instance.snapshot.warnings, warnings);
  assert.equal(instance.snapshot.connectionState, 'connected');
  assert.equal(instance.snapshot.lastSuccessfulSyncAt, observedAt);
  assert.deepEqual((await cached(folder)).warnings, warnings);
});

test('simultaneous refreshes share one request and report syncing until it finishes', async t => {
  const folder = await directory(t), request = deferred<DeadlineFetchResult>();
  let requests = 0, snapshotChanges = 0;
  const activity: boolean[] = [];
  const instance = service(t, folder, {
    fetch: () => { requests++; return request.promise; },
    changed: () => { snapshotChanges++; },
    syncChanged: () => { activity.push(instance.syncing); },
  });
  const first = instance.refresh(), second = instance.refresh();
  assert.equal(first, second);
  assert.equal(requests, 1);
  assert.equal(instance.syncing, true);
  assert.deepEqual(activity, [true]);
  request.resolve(result());
  await Promise.all([first, second]);
  assert.equal(instance.syncing, false);
  assert.deepEqual(activity, [true, false]);
  assert.equal(snapshotChanges, 1);
  assert.deepEqual(instance.snapshot.deadlines, [deadline()]);
});

test('every non-authenticated state prevents background fetching while preserving the last cache', async t => {
  const folder = await directory(t);
  let auth: AuthStatus['state'] = 'authenticated', requests = 0;
  const instance = service(t, folder, { authState: () => auth, fetch: async () => { requests++; return result(); } });
  await instance.refresh();
  for (const state of ['signed_out', 'connecting', 'needs_user', 'unconfigured'] as const) {
    auth = state;
    await instance.refresh();
    assert.equal(requests, 1);
    assert.equal(instance.snapshot.connectionState, state === 'unconfigured' ? 'unconfigured' : 'login_required');
    assert.equal(instance.snapshot.lastSuccessfulSyncAt, observedAt);
    assert.deepEqual(instance.snapshot.deadlines, [deadline()]);
  }
});

test('network and authentication failures preserve items, timestamps and partial warnings without exporting exception text', async t => {
  const folder = await directory(t), warnings = ['One Moodle source is unavailable'];
  let failure: Error | undefined;
  const instance = service(t, folder, { fetch: async () => { if (failure) throw failure; return result([deadline()], warnings); } });
  await instance.refresh();
  const before = instance.snapshot;
  failure = new Error('Raw internal exception includes school-password-secret');
  await instance.refresh();
  assert.deepEqual(instance.snapshot, { ...before, connectionState: 'error' });
  assert(!(await readFile(path.join(folder, 'snapshot.json'), 'utf8')).includes('school-password-secret'));
  failure = new AppError('AUTH_REQUIRED', 'Server response includes cookie-private');
  await instance.refresh();
  assert.deepEqual(instance.snapshot, { ...before, connectionState: 'login_required' });
  assert(!(await readFile(path.join(folder, 'snapshot.json'), 'utf8')).includes('cookie-private'));
});

test('an old account fetch cannot revive data after reset and does not block a new account refresh', async t => {
  const folder = await directory(t), oldRequest = deferred<DeadlineFetchResult>();
  let requests = 0;
  const activity: boolean[] = [];
  const instance = service(t, folder, {
    fetch: () => ++requests === 1 ? oldRequest.promise : Promise.resolve(result([deadline('new-account')])),
    syncChanged: () => { activity.push(instance.syncing); },
  });
  const generation = instance.captureGeneration(), oldRefresh = instance.refresh();
  await instance.reset();
  assert.notEqual(instance.captureGeneration(), generation);
  assert.deepEqual(instance.snapshot.deadlines, []);
  assert.equal(instance.syncing, false);
  await instance.refresh();
  oldRequest.resolve(result([deadline('old-account')]));
  await oldRefresh;
  await instance.accept(result([deadline('stale-manual-query')]), [course], generation);
  assert.deepEqual(instance.snapshot.deadlines.map((value: Deadline) => value.id), ['new-account']);
  assert.deepEqual((await cached(folder)).deadlines.map((value: Deadline) => value.id), ['new-account']);
  assert.deepEqual(activity, [true, false, true, false]);
});

test('reset clears memory immediately and wins over queued writes and an asynchronous change callback', async t => {
  const folder = await directory(t), entered = deferred<void>(), release = deferred<void>();
  let calls = 0;
  const instance = service(t, folder, { changed: async () => { if (++calls === 1) { entered.resolve(); await release.promise; } } });
  const generation = instance.captureGeneration();
  const first = instance.accept(result([deadline('already-writing')]), [course], generation);
  await entered.promise;
  const queued = instance.accept(result([deadline('queued-old-account')]), [course], generation);
  const reset = instance.reset();
  assert.deepEqual(instance.snapshot.deadlines, []);
  assert.equal(instance.snapshot.lastSuccessfulSyncAt, null);
  release.resolve();
  await Promise.all([first, queued, reset]);
  assert.deepEqual((await cached(folder)).deadlines, []);
  assert.equal((await cached(folder)).lastSuccessfulSyncAt, null);
  assert.equal(calls, 2);
});

test('logout during a request discards its successful result and retains the cached data', async t => {
  const folder = await directory(t), request = deferred<DeadlineFetchResult>();
  let auth: AuthStatus['state'] = 'authenticated';
  const instance = service(t, folder, { authState: () => auth, fetch: () => request.promise });
  await instance.accept(result([deadline('cached')]), [course], instance.captureGeneration());
  const refresh = instance.refresh();
  auth = 'signed_out';
  request.resolve(result([deadline('response-after-logout')]));
  await refresh;
  assert.equal(instance.snapshot.connectionState, 'login_required');
  assert.deepEqual(instance.snapshot.deadlines.map(value => value.id), ['cached']);
});

test('future selection sorts deadlines, expires them by exact timestamp and leaves the cache unchanged', async t => {
  const folder = await directory(t), instance = service(t, folder);
  await instance.accept(result([
    deadline('later', '2026-10-15T01:00:00+08:00'),
    deadline('expired', '2026-10-14T15:59:59.000Z'),
    deadline('now', '2026-10-14T16:00:00.000Z'),
  ]), [course], instance.captureGeneration());
  const now = Date.parse('2026-10-15T00:00:00+08:00');
  assert.deepEqual(instance.futureDeadlines(now - 1).map(value => value.id), ['now', 'later']);
  assert.deepEqual(instance.futureDeadlines(now).map(value => value.id), ['later']);
  assert.deepEqual(instance.futureDeadlines(now + 1).map(value => value.id), ['later']);
  const future = instance.futureDeadlines(now);
  future[0].name = 'Mutated display';
  assert.equal(instance.snapshot.deadlines.length, 3);
  assert.equal(instance.snapshot.deadlines[1].name, 'Report now');
});

test('a queued foreground result retains its data but reads authentication status when it commits', async t => {
  const folder = await directory(t), entered = deferred<void>(), release = deferred<void>();
  let auth: AuthStatus['state'] = 'authenticated', changes = 0;
  const instance = service(t, folder, {
    authState: () => auth,
    changed: async () => { if (++changes === 1) { entered.resolve(); await release.promise; } },
  });
  const generation = instance.captureGeneration();
  const first = instance.accept(result([deadline('first')]), [course], generation);
  await entered.promise;
  const foreground = instance.accept(result([deadline('foreground')]), [course], generation);
  auth = 'signed_out';
  release.resolve();
  await Promise.all([first, foreground]);
  assert.equal(instance.snapshot.connectionState, 'login_required');
  assert.deepEqual(instance.snapshot.deadlines.map(value => value.id), ['foreground']);
  assert.equal(instance.snapshot.lastSuccessfulSyncAt, observedAt);
  assert.deepEqual(await cached(folder), instance.snapshot);
});

test('sync completion is reported even when the fetch fails and activity callback errors do not affect cached data', async t => {
  const folder = await directory(t), activity: boolean[] = [];
  const instance = service(t, folder, {
    fetch: async () => { throw new Error('Network is unavailable'); },
    syncChanged: () => { activity.push(instance.syncing); throw new Error('UI is already closed'); },
  });
  await instance.refresh();
  assert.deepEqual(activity, [true, false]);
  assert.equal(instance.syncing, false);
  assert.equal(instance.snapshot.connectionState, 'error');
  assert.equal(instance.snapshot.lastSuccessfulSyncAt, null);
});

test('invalid live snapshots fail safely and leave the last successful snapshot intact', async t => {
  const folder = await directory(t), instance = service(t, folder);
  await instance.refresh();
  const before = instance.snapshot;
  await assert.rejects(instance.accept(result([{ ...deadline(), url: 'https://user:password@core.xjtlu.edu.cn/mod/assign/view.php?id=7' }]), [course], instance.captureGeneration()), error => error instanceof AppError && error.code === 'WIDGET_SNAPSHOT_INVALID');
  const large = Array.from({ length: 1500 }, (_, index) => ({ ...deadline(String(index)), name: 'x'.repeat(2000) }));
  await assert.rejects(instance.accept(result(large), [course], instance.captureGeneration()), error => error instanceof AppError && error.code === 'WIDGET_SNAPSHOT_INVALID');
  assert.deepEqual(instance.snapshot, before);
  assert.deepEqual(await cached(folder), before);
});

test('background authentication checks never start interactive login and cannot restore a cleared account', async () => {
  let probes = 0, connections = 0;
  const auth = {
    status: { state: 'authenticated' as AuthStatus['state'] },
    store: { settings: { username: 'old-account' } },
    pending: undefined,
    lastChecked: 0,
    probe: async () => { probes++; return true; },
    connect: async () => { connections++; },
    set(state: AuthStatus['state']) { this.status = { state }; },
    invalidate() { this.lastChecked = 0; this.status = { state: 'signed_out' }; },
  };
  const ensure = () => AuthService.prototype.ensureBackground.call(auth as unknown as AuthService);
  await ensure();
  assert.equal(probes, 1);
  await ensure();
  assert.equal(probes, 1);
  auth.lastChecked = 0;
  auth.probe = async () => { probes++; return false; };
  await assert.rejects(ensure(), error => error instanceof AppError && error.code === 'AUTH_REQUIRED');
  assert.equal(auth.status.state, 'signed_out');
  await assert.rejects(ensure(), error => error instanceof AppError && error.code === 'AUTH_REQUIRED');
  assert.equal(probes, 2);
  auth.status.state = 'authenticated';
  const probe = deferred<boolean>();
  auth.probe = async () => { probes++; return probe.promise; };
  const pending = ensure();
  auth.status.state = 'signed_out';
  auth.store.settings.username = 'new-account';
  probe.resolve(true);
  await assert.rejects(pending, error => error instanceof AppError && error.code === 'AUTH_REQUIRED');
  assert.equal(auth.status.state, 'signed_out');
  const supersededProbe = deferred<boolean>();
  auth.status = { state: 'authenticated' };
  auth.lastChecked = 0;
  auth.probe = async () => supersededProbe.promise;
  const superseded = ensure();
  auth.set('authenticated');
  auth.lastChecked = Date.now();
  supersededProbe.resolve(false);
  await superseded;
  assert.equal(auth.status.state, 'authenticated');
  assert.equal(connections, 0);
});
