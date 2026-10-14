import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, CORE } from '../src/shared.js';
import { responseHeaders } from '../src/http-headers.js';

test('Unicode disposition filenames become UTF-8 byte strings without throwing Headers ByteString errors', () => {
  for (const name of ['Lecture’s introduction.pdf', '第一课：简介.pdf']) {
    const original = `inline; filename="${name}"`;
    const headers = responseHeaders({ 'Content-Disposition': original }, CORE + '/mod/resource/view.php?id=7');
    const stored = headers.get('content-disposition')!;
    assert.equal(stored, Buffer.from(original, 'utf8').toString('latin1'));
    assert.equal(Buffer.from(stored, 'latin1').toString('utf8'), original);
    assert.ok([...stored].every(character => character.charCodeAt(0) <= 255));
  }
});

test('relative Unicode Location headers resolve to an encoded absolute URL', () => {
  const headers = responseHeaders({ Location: '../../pluginfile.php/42/mod_resource/content/0/第一课’s slides.pdf?forcedownload=1' }, CORE + '/mod/resource/view.php?id=7');
  assert.equal(headers.get('location'), CORE + '/pluginfile.php/42/mod_resource/content/0/%E7%AC%AC%E4%B8%80%E8%AF%BE%E2%80%99s%20slides.pdf?forcedownload=1');
});

test('already percent-encoded Location values stay encoded once', () => {
  const encoded = '/pluginfile.php/42/mod_resource/content/0/%E7%AC%AC%E4%B8%80%E8%AF%BE%20notes.pdf?name=%E4%B8%AD%E6%96%87';
  assert.equal(responseHeaders({ location: encoded }, CORE + '/mod/resource/view.php?id=7').get('location'), CORE + encoded);
  assert.equal(responseHeaders({ location: CORE + encoded }, CORE).get('location'), CORE + encoded);
});

test('ordinary ASCII and Latin-1 header values, arrays and undefined entries retain their behavior', () => {
  const headers = responseHeaders({
    'Content-Type': ['application/pdf'],
    'Content-Disposition': 'attachment; filename="notes.pdf"',
    'X-Items': ['first', 'second'],
    'Set-Cookie': ['session=one; Path=/', 'preference=two; Path=/'],
    'X-Latin1': 'café',
    'X-Missing': undefined,
  }, CORE);
  assert.equal(headers.get('content-type'), 'application/pdf');
  assert.equal(headers.get('content-disposition'), 'attachment; filename="notes.pdf"');
  assert.equal(headers.get('x-items'), 'first, second');
  assert.deepEqual(headers.getSetCookie(), ['session=one; Path=/', 'preference=two; Path=/']);
  assert.equal(headers.get('x-latin1'), 'café');
  assert.equal(headers.has('x-missing'), false);
});

test('invalid headers and invalid redirect values fail with a controlled message that excludes raw values', () => {
  const cases: Record<string, string | string[] | undefined>[] = [
    { 'Bad Header': 'private-value' },
    { '无效头': 'private-value' },
    { 'X-Private': 'private-value\r\nmalicious: injected' },
    { Location: '/private-value\r\nmalicious: injected' },
    { Location: 'https://[invalid-host/private-value' },
  ];
  for (const raw of cases) {
    assert.throws(() => responseHeaders(raw, CORE), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'MOODLE_HEADERS');
      assert.equal(error.message, '学校返回无效响应头，请重试。');
      assert.equal(error.message.includes('private-value'), false);
      return true;
    });
  }
});
