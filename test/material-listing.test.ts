import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, CORE, SSO } from '../src/shared.js';
import { MoodleClient } from '../src/moodle/client.js';
import { stableId } from '../src/moodle/parsers.js';

const courseId = '1214';
const courseUrl = CORE + '/course/view.php?id=' + courseId;
const activityUrl = (type: string, id: string) => `${CORE}/mod/${type}/view.php?id=${id}`;
const courseHtml = (links: Array<{ type: string; id: string; name: string }>) =>
  `<li class="course-section"><h3 class="sectionname">Week 2</h3>${links.map(link => `<a href="${activityUrl(link.type, link.id)}"><span class="instancename">${link.name}</span></a>`).join('')}</li>`;

function fixture(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const client = new MoodleClient({ fetch: async (url, init) => {
    requested.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.ok(routes[url], `Unexpected request: ${url}`);
    return routes[url]();
  } }, async () => undefined);
  client.courses.set(courseId, { id: courseId, name: 'PSP305-2627-S1-Final Year Project', shortName: 'PSP305', url: courseUrl });
  return { client, requested };
}

function binaryResponse(headers: Record<string, string>) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new TextEncoder().encode('%PDF-binary-body-must-not-be-read-while-listing'));
      controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers }), state };
}

test('resource redirects to PDF become listed materials without consuming the file body', async () => {
  const resourceUrl = activityUrl('resource', '7001');
  const fileUrl = CORE + '/pluginfile.php/882/mod_resource/content/0/Lecture%20slides.pdf';
  const binary = binaryResponse({ 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="Lecture slides.pdf"', 'content-length': '1234' });
  const { client, requested } = fixture({
    [courseUrl]: () => new Response(courseHtml([{ type: 'resource', id: '7001', name: 'Lecture slides: how to define a project' }])),
    [resourceUrl]: () => new Response(null, { status: 303, headers: { location: fileUrl + '?forcedownload=1' } }),
    [fileUrl + '?forcedownload=1']: () => binary.response,
  });
  const materials = await client.listMaterials([courseId]);
  assert.deepEqual(requested, [courseUrl, resourceUrl, fileUrl + '?forcedownload=1']);
  assert.equal(materials.length, 1);
  assert.deepEqual(materials[0], { id: stableId(courseId, fileUrl), courseId, section: 'Week 2', name: 'Lecture slides.pdf', url: fileUrl, kind: 'file', activityUrl: resourceUrl, mime: 'application/pdf', size: 1234 });
  assert.equal(client.materials.get(materials[0].id), materials[0]);
  assert.equal(binary.state.cancelled, true);
  assert.equal(binary.state.pulls, 0);
});

test('embedded PDF wrappers still discover their file and deduplicate forcedownload variants', async () => {
  const resourceUrl = activityUrl('resource', '7002');
  const fileUrl = CORE + '/pluginfile.php/883/mod_resource/content/0/embedded.pdf';
  const { client, requested } = fixture({
    [courseUrl]: () => new Response(courseHtml([{ type: 'resource', id: '7002', name: 'Embedded lecture' }])),
    [resourceUrl]: () => new Response(`<object data="${fileUrl}?forcedownload=0"></object><a href="${fileUrl}?forcedownload=1">Download</a>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  const materials = await client.listMaterials([courseId]);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].url, fileUrl);
  assert.equal(materials[0].id, stableId(courseId, fileUrl));
  assert.equal(materials[0].activityUrl, resourceUrl);
  assert.deepEqual(requested, [courseUrl, resourceUrl]);
});

test('folder HTML retains every distinct attachment including same-named files in separate subfolders', async () => {
  const folderUrl = activityUrl('folder', '7003');
  const paths = ['/pluginfile.php/884/mod_folder/content/0/Week1/notes.pdf', '/pluginfile.php/884/mod_folder/content/0/Week2/notes.pdf', '/pluginfile.php/884/mod_folder/content/0/project.docx'];
  const { client } = fixture({
    [courseUrl]: () => new Response(courseHtml([{ type: 'folder', id: '7003', name: 'Project materials' }])),
    [folderUrl]: () => new Response(paths.map(path => `<a href="${path}?forcedownload=1">Download</a>`).join(''), { headers: { 'content-type': 'text/html' } }),
  });
  const materials = await client.listMaterials([courseId]);
  assert.equal(materials.length, 3);
  assert.equal(new Set(materials.map(material => material.id)).size, 3);
  assert.deepEqual(materials.map(material => material.url), paths.map(path => CORE + path));
  assert.deepEqual(materials.map(material => material.name), ['notes.pdf', 'notes.pdf', 'project.docx']);
  assert.ok(materials.every(material => material.section === 'Week 2' && material.kind === 'file' && material.activityUrl === folderUrl));
});

test('external URL activity redirects remain links and never fetch their external destination', async () => {
  const urlActivity = activityUrl('url', '7004');
  const target = 'https://video.example.net/watch?v=lecture';
  const redirectBody = binaryResponse({ 'content-type': 'text/html' });
  const { client, requested } = fixture({
    [courseUrl]: () => new Response(courseHtml([{ type: 'url', id: '7004', name: 'Online Lecture Recording' }])),
    [urlActivity]: () => new Response(redirectBody.response.body, { status: 303, headers: { location: target } }),
  });
  const materials = await client.listMaterials([courseId]);
  assert.deepEqual(requested, [courseUrl, urlActivity]);
  assert.deepEqual(materials, [{ id: stableId(courseId, target), courseId, section: 'Week 2', name: 'Online Lecture Recording', url: target, kind: 'link', activityUrl: urlActivity }]);
  assert.equal(redirectBody.state.cancelled, true);
  assert.equal(redirectBody.state.pulls, 0);
});

test('SSO and login redirects report expired authentication instead of becoming materials', async () => {
  for (const target of [SSO + '/esc-sso/login/page', CORE + '/auth/saml2/login.php', CORE + '/login/index.php']) {
    const urlActivity = activityUrl('url', '7005');
    const { client, requested } = fixture({
      [courseUrl]: () => new Response(courseHtml([{ type: 'url', id: '7005', name: 'Course link' }])),
      [urlActivity]: () => new Response(null, { status: 303, headers: { location: target } }),
      [CORE + '/login/index.php']: () => new Response('<body id="page-login-index"><form action="/login/index.php"><input type="password"></form></body>', { headers: { 'content-type': 'text/html' } }),
    });
    await assert.rejects(client.listMaterials([courseId]), (error: unknown) => error instanceof AppError && error.code === 'AUTH_REQUIRED');
    assert.equal(client.materials.size, 0);
    assert.ok(requested.every(url => new URL(url).origin === CORE));
  }
});

test('unknown binary page responses are cancelled and are not inferred as downloadable materials', async () => {
  const pageUrl = activityUrl('page', '7006');
  const binary = binaryResponse({ 'content-type': 'application/octet-stream' });
  const { client } = fixture({
    [courseUrl]: () => new Response(courseHtml([{ type: 'page', id: '7006', name: 'Course page' }])),
    [pageUrl]: () => binary.response,
  });
  assert.deepEqual(await client.listMaterials([courseId]), []);
  assert.equal(client.materials.size, 0);
  assert.equal(client.sources.size, 0);
  assert.equal(binary.state.cancelled, true);
  assert.equal(binary.state.pulls, 0);
});

test('embedded video and text-only Moodle pages stay visible as links with page evidence',async()=>{
  const videoUrl=activityUrl('url','7010'),pageUrl=activityUrl('page','7011');
  const {client,requested}=fixture({
    [courseUrl]:()=>new Response(courseHtml([{type:'url',id:'7010',name:'Online Lecture Recording'},{type:'page',id:'7011',name:'Week 1 Introduction'}])),
    [videoUrl]:()=>new Response('<iframe src="https://video.example.net/embedded"></iframe>',{headers:{'content-type':'text/html'}}),
    [pageUrl]:()=>new Response('<main>Introduction and reading list</main>',{headers:{'content-type':'text/html'}}),
  });
  const materials=await client.listMaterials([courseId]);
  assert.deepEqual(materials.map(m=>({name:m.name,url:m.url,kind:m.kind})),[{name:'Online Lecture Recording',url:videoUrl,kind:'link'},{name:'Week 1 Introduction',url:pageUrl,kind:'link'}]);
  assert.equal(client.sources.size,1);assert.equal([...client.sources.values()][0].url,pageUrl);
  assert.ok(requested.every(url=>new URL(url).origin===CORE));
});
