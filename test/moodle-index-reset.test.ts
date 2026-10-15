import test from 'node:test';
import assert from 'node:assert/strict';
import { MoodleClient } from '../src/moodle/client.js';
import { AppError, CORE, type Course, type Material, type Source } from '../src/shared.js';

const oldCourse: Course = { id: '42', name: 'Old course', shortName: 'OLD101', url: CORE + '/course/view.php?id=42' };
const newCourse: Course = { id: '43', name: 'New course', shortName: 'NEW101', url: CORE + '/course/view.php?id=43' };
const newMaterial: Material = { id: 'new-material', courseId: '43', name: 'new.pdf', section: 'Week 1', kind: 'file', activityUrl: CORE + '/mod/resource/view.php?id=9', url: CORE + '/pluginfile.php/43/mod_resource/content/0/new.pdf' };
const newSource: Source = { id: 'new-source', courseId: '43', name: 'New evidence', kind: 'material', url: newMaterial.activityUrl, materialId: newMaterial.id };
const staleError = (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function populateCurrent(client: MoodleClient) {
  client.courses.set(newCourse.id, newCourse);
  client.materials.set(newMaterial.id, newMaterial);
  client.sources.set(newSource.id, newSource);
}
function assertCurrent(client: MoodleClient) {
  assert.deepEqual([...client.courses.values()], [newCourse]);
  assert.deepEqual([...client.materials.values()], [newMaterial]);
  assert.deepEqual([...client.sources.values()], [newSource]);
}

test('an old delayed course AJAX result cannot overwrite a course refresh after clear', async () => {
  const entered = deferred<void>(), response = deferred<Response>();
  let posts = 0;
  const client = new MoodleClient({ fetch: async (_url, init) => {
    if (init?.method !== 'POST') return new Response('<script>M.cfg={"sesskey":"test"}</script>');
    if (++posts === 1) { entered.resolve(); return response.promise; }
    return Response.json([{ data: { courses: [{ id: 43, fullname: newCourse.name, shortname: newCourse.shortName }] } }]);
  } }, async () => undefined);
  const old = client.listCourses();
  await entered.promise;
  client.clear();
  assert.deepEqual(await client.listCourses(), [newCourse]);
  response.resolve(Response.json([{ data: { courses: [{ id: 42, fullname: oldCourse.name, shortname: oldCourse.shortName }], nextoffset: 100 } }]));
  await assert.rejects(old, staleError);
  assert.deepEqual([...client.courses.values()], [newCourse]);
  assert.equal(posts, 2);
});

test('an old delayed fallback course page cannot restore the old index after clear', async () => {
  const entered = deferred<void>(), response = deferred<Response>();
  const client = new MoodleClient({ fetch: async url => {
    if (url.endsWith('/my/courses.php')) { entered.resolve(); return response.promise; }
    return new Response('<main>No AJAX session key</main>');
  } }, async () => undefined);
  const old = client.listCourses();
  await entered.promise;
  client.clear();populateCurrent(client);
  response.resolve(new Response(`<a href="${oldCourse.url}">${oldCourse.name}</a>`));
  await assert.rejects(old, staleError);
  assertCurrent(client);
});

test('clearing while authentication is pending prevents old course and material requests from starting', async () => {
  for (const kind of ['courses', 'materials'] as const) {
    const entered = deferred<void>(), authenticated = deferred<void>();
    let requests = 0;
    const client = new MoodleClient({ fetch: async () => { requests++; return new Response(''); } }, async () => { entered.resolve(); await authenticated.promise; });
    client.courses.set(oldCourse.id, oldCourse);
    const old = kind === 'courses' ? client.listCourses() : client.listMaterials([oldCourse.id]);
    await entered.promise;
    client.clear();populateCurrent(client);
    authenticated.resolve();
    await assert.rejects(old, staleError);
    assert.equal(requests, 0);
    assertCurrent(client);
  }
});

test('a delayed old course page does not start its material activity requests or replace the current index', async () => {
  const entered = deferred<void>(), response = deferred<Response>(), requests: string[] = [];
  const oldActivity = CORE + '/mod/resource/view.php?id=7';
  const client = new MoodleClient({ fetch: async url => {
    requests.push(url);
    assert.equal(url, oldCourse.url);
    entered.resolve();return response.promise;
  } }, async () => undefined);
  client.courses.set(oldCourse.id, oldCourse);
  const old = client.listMaterials([oldCourse.id]);
  await entered.promise;
  client.clear();populateCurrent(client);
  response.resolve(new Response(`<a href="${oldActivity}">Old slides</a>`));
  await assert.rejects(old, staleError);
  assert.deepEqual(requests, [oldCourse.url]);
  assertCurrent(client);
});

test('late old material responses are cancelled and stale redirects never continue under the new index', async () => {
  for (const redirect of [false, true]) {
    const entered = deferred<void>(), response = deferred<Response>(), requests: string[] = [];
    const oldActivity = CORE + '/mod/resource/view.php?id=7';
    let cancelled = false;
    const client = new MoodleClient({ fetch: async url => {
      requests.push(url);
      if (url === oldCourse.url) return new Response(`<a href="${oldActivity}">Old slides</a>`);
      assert.equal(url, oldActivity);
      entered.resolve();return response.promise;
    } }, async () => undefined);
    client.courses.set(oldCourse.id, oldCourse);
    const old = client.listMaterials([oldCourse.id]);
    await entered.promise;
    client.clear();populateCurrent(client);
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    response.resolve(new Response(body, redirect ? { status: 303, headers: { location: CORE + '/pluginfile.php/42/mod_resource/content/0/old.pdf' } } : { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="old.pdf"' } }));
    await assert.rejects(old, staleError);
    assert.equal(cancelled, true);
    assert.deepEqual(requests, [oldCourse.url, oldActivity]);
    assertCurrent(client);
  }
});

test('a material page body finishing after clear cannot commit old materials or page evidence', async () => {
  const entered = deferred<void>(), oldPage = CORE + '/mod/page/view.php?id=7';
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { entered.resolve(); } }, { highWaterMark: 0 });
  const client = new MoodleClient({ fetch: async url => {
    if (url === oldCourse.url) return new Response(`<a href="${oldPage}">Old page evidence</a>`);
    assert.equal(url, oldPage);return new Response(body, { headers: { 'content-type': 'text/html' } });
  } }, async () => undefined);
  client.courses.set(oldCourse.id, oldCourse);
  const old = client.listMaterials([oldCourse.id]);
  await entered.promise;
  client.clear();populateCurrent(client);
  controller.enqueue(new TextEncoder().encode('<main>Old instructions</main>'));controller.close();
  await assert.rejects(old, staleError);
  assertCurrent(client);
});

test('a delayed old announcement source cannot restore sources after clear', async () => {
  const entered = deferred<void>(), response = deferred<Response>(), oldForum = CORE + '/mod/forum/view.php?id=8';
  const client = new MoodleClient({ fetch: async url => {
    if (url === oldCourse.url) return new Response(`<a href="${oldForum}">Announcements</a>`);
    assert.equal(url, oldForum);entered.resolve();return response.promise;
  } }, async () => undefined);
  client.courses.set(oldCourse.id, oldCourse);
  const old = client.listSources([oldCourse.id]);
  await entered.promise;
  client.clear();populateCurrent(client);
  response.resolve(new Response('<h1>Announcements</h1><a href="/mod/forum/discuss.php?d=9">Old project update</a>'));
  await assert.rejects(old, staleError);
  assertCurrent(client);
});
