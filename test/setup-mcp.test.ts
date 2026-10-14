import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleUrl = pathToFileURL(path.join(__dirname, '../scripts/setup-mcp.mjs')).href;
const setupModule = import(moduleUrl);
async function configureMcp(options: Record<string, unknown>) { return (await setupModule).configureMcp(options); }
async function mergeJsonConfig(file: string, entry: object) { return (await setupModule).mergeJsonConfig(file, entry); }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'xipu-setup-'));
  const app = path.join(root, 'Applications', 'XIPU MCP.app');
  const launcher = path.join(app, 'Contents', 'Resources', 'xipu-mcp');
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, app, launcher, home: root, configOutput: path.join(root, 'export', 'mcp.json'), close: () => rm(root, { recursive: true, force: true }) };
}

test('Cursor setup preserves other servers and settings with a private original backup, then is idempotent', async () => {
  const f = await fixture();
  try {
    const config = path.join(f.home, '.cursor', 'mcp.json');
    const original = '{"mcpServers":{"existing":{"command":"keep","env":{"SECRET":"existing-only"}},"xipu-mcp":{"command":"old"}},"userSetting":true}\n';
    await mkdir(path.dirname(config)); await writeFile(config, original, { mode: 0o644 });
    const result = await configureMcp({ ...f, client: 'cursor' });
    const data = JSON.parse(await readFile(config, 'utf8'));
    assert.equal(data.userSetting, true);
    assert.deepEqual(data.mcpServers.existing, { command: 'keep', env: { SECRET: 'existing-only' } });
    assert.deepEqual(data.mcpServers['xipu-mcp'], { type: 'stdio', command: f.launcher, args: [] });
    assert.equal(await readFile(result.backupPath, 'utf8'), original);
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    assert(!await readFile(f.configOutput, 'utf8').then(text => text.includes('existing-only')));
    const before = await stat(config);
    const second = await configureMcp({ ...f, client: 'cursor' });
    assert.equal(second.changed, false); assert.equal(second.exportChanged, false);
    assert.equal((await stat(config)).mtimeMs, before.mtimeMs);
    assert.equal((await readdir(path.dirname(config))).filter(name => name.includes('backup')).length, 1);
  } finally { await f.close(); }
});

test('Claude Desktop uses its own configuration and does not touch Cursor', async () => {
  const f = await fixture();
  try {
    const result = await configureMcp({ ...f, client: 'claude-desktop' });
    assert.equal(result.configPath, path.join(f.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    assert.deepEqual(JSON.parse(await readFile(result.configPath, 'utf8')), { mcpServers: { 'xipu-mcp': { command: f.launcher, args: [] } } });
    await assert.rejects(stat(path.join(f.home, '.cursor')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('invalid JSON and schema keep the configuration untouched without a backup', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, 'invalid.json');
    for (const text of ['{invalid', '[]', '{"mcpServers":null}', '{"mcpServers":[]}']) {
      await writeFile(file, text);
      await assert.rejects(mergeJsonConfig(file, { command: f.launcher, args: [] }));
      assert.equal(await readFile(file, 'utf8'), text);
    }
    assert(!(await readdir(f.root)).some(name => name.includes('backup') || name.endsWith('.tmp')));
  } finally { await f.close(); }
});

test('config-only exports no credentials and launcher validation happens before writing', async () => {
  const f = await fixture();
  try {
    const result = await configureMcp({ ...f, client: 'config-only' });
    assert.equal(result.configPath, undefined); assert.equal(result.changed, false);
    assert.deepEqual(JSON.parse(await readFile(f.configOutput, 'utf8')), { mcpServers: { 'xipu-mcp': { command: f.launcher, args: [] } } });
    await assert.rejects(configureMcp({ ...f, client: 'config-only', app: path.join(f.root, 'Missing.app'), configOutput: path.join(f.root, 'missing.json') }));
    await assert.rejects(stat(path.join(f.root, 'missing.json')), { code: 'ENOENT' });
    await assert.rejects(configureMcp({ ...f, client: 'all' }));
  } finally { await f.close(); }
});

test('symlink configuration and export targets are refused', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, 'target.json'), link = path.join(f.root, 'link.json');
    await writeFile(target, '{"preserve":true}'); await symlink(target, link);
    await assert.rejects(mergeJsonConfig(link, { command: f.launcher }), /non-regular/);
    await assert.rejects(configureMcp({ ...f, client: 'config-only', configOutput: link }), /non-regular/);
    assert.equal(await readFile(target, 'utf8'), '{"preserve":true}');
    await assert.rejects(configureMcp({ ...f, client: 'cursor', configOutput: path.join(f.home, '.cursor', 'mcp.json') }), /separate path/);
  } finally { await f.close(); }
});

test('missing Codex CLI fails clearly while leaving an exported JSON', async () => {
  const f = await fixture();
  try {
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); return { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }; };
    await assert.rejects(configureMcp({ ...f, client: 'codex', run }), /Codex CLI was not found/);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(await readFile(f.configOutput, 'utf8')).mcpServers['xipu-mcp'].command, f.launcher);
    await assert.rejects(stat(path.join(f.home, '.codex')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('Codex uses the official CLI arguments, privately backs up settings and verifies the result', async () => {
  const f = await fixture();
  try {
    const configPath = path.join(f.home, '.codex', 'config.toml');
    await mkdir(path.dirname(configPath)); const original = 'model = "existing-model"\n'; await writeFile(configPath, original);
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (calls.length === 1) return { status: 1, stdout: '', stderr: "Error: No MCP server named 'xipu-mcp' found." };
      return { status: 0, stdout: JSON.stringify({ enabled: true, transport: { type: 'stdio', command: f.launcher, args: [], env: null } }), stderr: '' };
    };
    const result = await configureMcp({ ...f, client: 'codex', run });
    assert.deepEqual(calls, [['mcp', 'get', 'xipu-mcp', '--json'], ['mcp', 'add', 'xipu-mcp', '--', f.launcher], ['mcp', 'get', 'xipu-mcp', '--json']]);
    assert.equal(result.changed, true); assert.equal(await readFile(result.backupPath, 'utf8'), original);
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const secondCalls: string[][] = [];
    const second = await configureMcp({ ...f, client: 'codex', run: (args: string[]) => { secondCalls.push(args); return run(['mcp', 'get', 'xipu-mcp', '--json']); } });
    assert.equal(second.changed, false); assert.equal(secondCalls.length, 1);
    assert.equal((await readdir(path.dirname(configPath))).filter(name => name.includes('backup')).length, 1);
  } finally { await f.close(); }
});

test('Codex configuration errors or failed verification do not claim success or expose CLI output', async () => {
  const f = await fixture();
  try {
    await assert.rejects(configureMcp({ ...f, client: 'codex', run: () => ({ status: 1, stderr: 'Sensitive config parse error', stdout: '' }) }), error => error instanceof Error && !error.message.includes('Sensitive'));
    let calls = 0;
    const run = () => ++calls === 1 ? { status: 1, stderr: "No MCP server named 'xipu-mcp' found" } : calls === 2 ? { status: 0 } : { status: 0, stdout: '{}' };
    await assert.rejects(configureMcp({ ...f, client: 'codex', run }), /did not confirm/);
  } finally { await f.close(); }
});
