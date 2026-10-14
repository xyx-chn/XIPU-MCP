import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Installation helpers run as plain Node ESM, outside App code.
import { installApp } from '../scripts/install-app.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xipu-install-test-'));
  const source = path.join(root, 'source', 'XIPU MCP.app');
  const destination = path.join(root, 'Applications', 'XIPU MCP.app');
  for (const file of ['Contents/MacOS/XIPU MCP', 'Contents/Resources/node', 'Contents/Resources/xipu-mcp', 'Contents/Resources/bridge.cjs']) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), 'new app', { mode: 0o755 });
  }
  return { root, source, destination, copy: (from: string, to: string) => cp(from, to, { recursive: true }), running: () => false };
}

test('App install copies entrypoints and replaces only its destination', async () => {
  const f = await fixture();
  try {
    await mkdir(f.destination, { recursive: true });
    await writeFile(path.join(f.destination, 'old'), 'old app');
    const unrelated = path.join(f.root, 'Applications', 'Other.app');
    await writeFile(unrelated, 'unrelated');
    await installApp(f.source, f.destination, f);
    assert.equal(await readFile(path.join(f.destination, 'Contents/Resources/node'), 'utf8'), 'new app');
    assert.equal(await readFile(unrelated, 'utf8'), 'unrelated');
    assert.deepEqual((await readdir(path.dirname(f.destination))).sort(), ['Other.app', 'XIPU MCP.app']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed App copy leaves previous installation intact and removes staging', async () => {
  const f = await fixture();
  try {
    await mkdir(f.destination, { recursive: true });
    await writeFile(path.join(f.destination, 'old'), 'old app');
    await assert.rejects(installApp(f.source, f.destination, { ...f, copy: async (_: string, stage: string) => { await mkdir(stage); throw new Error('disk full'); } }), /disk full/);
    assert.equal(await readFile(path.join(f.destination, 'old'), 'utf8'), 'old app');
    assert.deepEqual(await readdir(path.dirname(f.destination)), ['XIPU MCP.app']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('running App or a symlink destination is never overwritten', async () => {
  const f = await fixture();
  try {
    await mkdir(f.destination, { recursive: true });
    await writeFile(path.join(f.destination, 'old'), 'old app');
    await assert.rejects(installApp(f.source, f.destination, { ...f, running: () => true }), /running/);
    assert.equal(await readFile(path.join(f.destination, 'old'), 'utf8'), 'old app');
    await rm(f.destination, { recursive: true });
    await symlink(f.source, f.destination);
    await assert.rejects(installApp(f.source, f.destination, f), /symlink/);
    await assert.rejects(installApp(f.source, path.join(f.root, 'Other.app'), f), /destination/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a fresh installation stops when another copy owns the running App', async () => {
  const f = await fixture();
  try {
    await assert.rejects(installApp(f.source, f.destination, { ...f, running: () => true }), /running/);
    await assert.rejects(readFile(path.join(f.destination, 'Contents/Resources/node')), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
