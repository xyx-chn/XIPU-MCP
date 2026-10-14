import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE } from '../src/shared.js';
import { materialFromFileResponse } from '../src/moodle/file-response.js';
import { parseFiles, type Activity } from '../src/moodle/parsers.js';
import { responseHeaders } from '../src/http-headers.js';

const activity: Activity = { id: '77', courseId: '42', name: 'Lecture 1', section: 'Week 1', type: 'resource', url: CORE + '/mod/resource/view.php?id=77' };
const fileUrl = CORE + '/pluginfile.php/100/mod_resource/content/0/lecture.pdf';

test('direct pluginfile response matches HTML discovery IDs and retains file metadata', () => {
  const headers = new Headers({ 'content-type': 'application/pdf; charset=binary', 'content-disposition': 'inline; filename="Lecture Slides.pdf"', 'content-length': '1234', 'last-modified': 'Wed, 14 Oct 2026 10:00:00 GMT' });
  const file = materialFromFileResponse(activity, fileUrl + '?forcedownload=1', headers)!;
  assert.equal(file.id, parseFiles(`<object data="${fileUrl}?forcedownload=0"></object>`, activity)[0].id);
  assert.equal(file.url, fileUrl); assert.equal(file.name, 'Lecture Slides.pdf');
  assert.equal(file.mime, 'application/pdf'); assert.equal(file.size, 1234);
  assert.equal(file.modified, Date.parse('2026-10-14T10:00:00Z'));
  assert.equal(file.section, activity.section); assert.equal(file.activityUrl, activity.url);
});

test('Content-Disposition supplies filenames without a file extension in the URL', () => {
  const headers = new Headers({ 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'content-disposition': `attachment; filename="fallback.pptx"; filename*=UTF-8'zh'%E7%AC%AC%E4%B8%80%E8%AF%BE.pptx` });
  assert.equal(materialFromFileResponse(activity, fileUrl.replace('lecture.pdf', 'download'), headers)?.name, '第一课.pptx');
  assert.equal(materialFromFileResponse(activity, fileUrl.replace('lecture.pdf', 'download'), new Headers({ 'content-type': 'application/pdf' }))?.name, 'download.pdf');
});

test('known resource may serve an attachment directly, unknown activity URLs are denied', () => {
  const headers = new Headers({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="notes.pdf"' });
  assert.equal(materialFromFileResponse(activity, activity.url + '&forcedownload=1', headers)?.name, 'notes.pdf');
  assert.equal(materialFromFileResponse(activity, activity.url.replace('id=77', 'id=78'), headers), undefined);
  assert.equal(materialFromFileResponse({ ...activity, type: 'page' }, activity.url, headers), undefined);
  assert.equal(materialFromFileResponse(activity, CORE + '/course/view.php?id=42', headers), undefined);
  assert.equal(materialFromFileResponse(activity, CORE + '/login/index.php', headers), undefined);
});

test('file discovery rejects foreign, credential-bearing and noncanonical pluginfile origins', () => {
  const headers = new Headers({ 'content-type': 'application/pdf' });
  for (const url of [fileUrl.replace(CORE, 'https://evil.example'), fileUrl.replace('core.xjtlu.edu.cn', 'core.xjtlu.edu.cn.evil.example'), fileUrl.replace('https://', 'https://user:pass@'), fileUrl.replace('https:', 'http:'), fileUrl.replace('/pluginfile.php/', '/other/pluginfile.php/'), CORE + '/pluginfile.php']) {
    assert.equal(materialFromFileResponse(activity, url, headers), undefined, url);
  }
});

test('HTML/login pages and streamed media cannot become downloadable course files', () => {
  for (const mime of ['text/html', 'application/xhtml+xml', 'video/mp4', 'audio/mpeg']) assert.equal(materialFromFileResponse(activity, fileUrl, new Headers({ 'content-type': mime })), undefined);
  assert.equal(materialFromFileResponse(activity, fileUrl.replace('.pdf', '.mp4'), new Headers({ 'content-type': 'application/octet-stream' })), undefined);
  assert.equal(materialFromFileResponse(activity, fileUrl, new Headers()), undefined);
  assert.equal(materialFromFileResponse(activity, activity.url, new Headers({ 'content-disposition': 'inline; filename="notes.pdf"' })), undefined);
});

test('attachment names are basenames and invalid metadata cannot affect download size', () => {
  const headers = new Headers({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../../notes.pdf"', 'content-length': '-1', 'last-modified': 'invalid' });
  const file = materialFromFileResponse(activity, fileUrl, headers)!;
  assert.equal(file.name, 'notes.pdf'); assert.equal(file.size, undefined); assert.equal(file.modified, undefined);
  headers.set('content-length', '999'); headers.set('content-encoding', 'gzip');
  assert.equal(materialFromFileResponse(activity, fileUrl, headers)?.size, undefined);
  headers.set('content-disposition', `attachment; filename*=UTF-8''%ZZ; filename="fallback.pdf"`);
  assert.equal(materialFromFileResponse(activity, fileUrl, headers)?.name, 'fallback.pdf');
});

test('Chromium Unicode filenames recover from normalized HTTP header bytes',()=>{
  const filename='Lecture’s 第一课.pdf';
  const headers=responseHeaders({'content-type':'application/pdf','content-disposition':`attachment; filename="${filename}"`},fileUrl);
  assert.equal(materialFromFileResponse(activity,fileUrl,headers)?.name,filename);
  assert.equal(materialFromFileResponse(activity,fileUrl,new Headers({'content-type':'application/pdf','content-disposition':'attachment; filename="caf\xe9.pdf"'}))?.name,'café.pdf');
});
