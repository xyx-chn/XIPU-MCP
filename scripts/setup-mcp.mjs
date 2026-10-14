#!/usr/bin/env node
// Client formats: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
// https://cursor.com/docs/mcp and https://modelcontextprotocol.io/docs/develop/connect-local-servers
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CLIENTS = ['codex', 'claude-desktop', 'cursor', 'config-only'];
const SERVER = 'xipu-mcp';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function snapshot(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing a non-regular configuration file: ${file}`);
    if (process.getuid && stat.uid !== process.getuid()) throw new Error(`Configuration is owned by another user: ${file}`);
    return { text: await readFile(file, 'utf8'), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function unchanged(file, original) {
  const current = await snapshot(file);
  if (original === null ? current !== null : !current || current.ino !== original.ino || current.mtimeMs !== original.mtimeMs || current.text !== original.text) {
    throw new Error(`Configuration changed during setup; retry after the other writer finishes: ${file}`);
  }
}

async function backup(file, original) {
  const backupPath = `${file}.xipu-backup-${Date.now()}-${randomUUID()}`;
  const handle = await open(backupPath, 'wx', 0o600);
  try { await handle.writeFile(original.text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  return backupPath;
}

async function atomicWrite(file, text, original) {
  if (original?.text === text) return { changed: false };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let backupPath;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await unchanged(file, original);
    if (original) backupPath = await backup(file, original);
    await unchanged(file, original);
    await rename(temporary, file);
    return { changed: true, backupPath };
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function mergeJsonConfig(file, entry) {
  const original = await snapshot(file);
  let config = {};
  if (original) {
    try { config = JSON.parse(original.text); } catch { throw new Error(`Invalid JSON; the existing configuration was preserved: ${file}`); }
    if (!isObject(config) || (Object.hasOwn(config, 'mcpServers') && !isObject(config.mcpServers))) {
      throw new Error(`Expected an object with an optional mcpServers object; configuration was preserved: ${file}`);
    }
  }
  if (JSON.stringify(config.mcpServers?.[SERVER]) === JSON.stringify(entry)) return { changed: false };
  const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [SERVER]: entry } };
  return atomicWrite(file, JSON.stringify(next, null, 2) + '\n', original);
}

function runCodex(args) {
  return spawnSync('codex', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true });
}

function checkCodexResult(result, action) {
  if (result.error?.code === 'ENOENT') throw new Error('Codex CLI was not found on PATH. The exported MCP JSON is ready; install the CLI or configure its MCP settings manually.');
  if (result.error) throw new Error(`Codex ${action} could not run. The exported MCP JSON is ready; check CLI permissions and retry.`);
}

async function configureCodex(launcher, configPath, run) {
  const before = run(['mcp', 'get', SERVER, '--json']);
  checkCodexResult(before, 'inspection');
  if (before.status === 0) {
    let server;
    try { server = JSON.parse(before.stdout); } catch { throw new Error('Codex returned an unsupported configuration format; no Codex settings were modified.'); }
    const transport = server.transport;
    if (server.enabled !== false && transport?.type === 'stdio' && transport.command === launcher &&
      (!transport.args || transport.args.length === 0) && (!transport.env || Object.keys(transport.env).length === 0)) {
      return { changed: false };
    }
  } else if (!/No MCP server named .+ found/i.test(before.stderr ?? '')) {
    throw new Error('Codex configuration could not be inspected; no Codex settings were modified. Check `codex mcp get xipu-mcp --json`.');
  }
  const original = await snapshot(configPath);
  const backupPath = original ? await backup(configPath, original) : undefined;
  await unchanged(configPath, original);
  const result = run(['mcp', 'add', SERVER, '--', launcher]);
  checkCodexResult(result, 'configuration');
  if (result.status !== 0) throw new Error(`Codex refused the configuration. The exported MCP JSON is ready${backupPath ? `; backup: ${backupPath}` : ''}.`);
  const after = run(['mcp', 'get', SERVER, '--json']);
  checkCodexResult(after, 'verification');
  let verified;
  try { verified = JSON.parse(after.stdout ?? ''); } catch { /* Report a verification failure below without exposing CLI output. */ }
  if (after.status !== 0 || verified?.transport?.type !== 'stdio' || verified.transport.command !== launcher || verified.enabled === false) {
    throw new Error(`Codex did not confirm the expected launcher${backupPath ? `; backup: ${backupPath}` : ''}.`);
  }
  const final = await snapshot(configPath);
  if (final) await chmod(configPath, 0o600);
  return { changed: true, backupPath };
}

/** Library options allow an isolated home and CLI runner for tests; the CLI always uses the current user's home. */
export async function configureMcp({ client, app, configOutput, home = homedir(), run = runCodex, codexDirectory } = {}) {
  if (!CLIENTS.includes(client)) throw new Error(`Choose one client: ${CLIENTS.join(', ')}.`);
  if (!app || !configOutput) throw new Error('Both --app and --config-output are required.');
  const appPath = path.resolve(app);
  const launcher = path.join(appPath, 'Contents', 'Resources', 'xipu-mcp');
  const launcherStat = await lstat(launcher).catch(() => null);
  if (!appPath.endsWith('.app') || !launcherStat?.isFile() || launcherStat.isSymbolicLink()) throw new Error(`The installed App launcher was not found: ${launcher}`);
  await access(launcher, constants.X_OK).catch(() => { throw new Error(`The installed App launcher is not executable: ${launcher}`); });
  const exportPath = path.resolve(configOutput);
  const configPath = client === 'cursor' ? path.join(home, '.cursor', 'mcp.json')
    : client === 'claude-desktop' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : client === 'codex' ? path.join(codexDirectory ?? (home === homedir() && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(home, '.codex')), 'config.toml') : undefined;
  if (configPath && path.resolve(configPath) === exportPath) throw new Error('The exported JSON must use a separate path from the client configuration.');
  const entry = { command: launcher, args: [] };
  const exported = { mcpServers: { [SERVER]: entry } };
  const exportResult = await atomicWrite(exportPath, JSON.stringify(exported, null, 2) + '\n', await snapshot(exportPath));
  let configured = { changed: false };
  if (client === 'cursor' || client === 'claude-desktop') configured = await mergeJsonConfig(configPath, client === 'cursor' ? { type: 'stdio', ...entry } : entry);
  else if (client === 'codex') configured = await configureCodex(launcher, configPath, run);
  return { client, launcher, configPath, exportPath, ...configured, exportChanged: exportResult.changed, exportBackupPath: exportResult.backupPath };
}

function parseArguments(argv) {
  const options = {};
  const names = { '--client': 'client', '--app': 'app', '--config-output': 'configOutput' };
  for (let index = 0; index < argv.length; index++) {
    const key = names[argv[index]];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${argv[index]}`);
    options[key] = argv[++index];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    console.log('Usage: node scripts/setup-mcp.mjs --client codex|claude-desktop|cursor|config-only --app "/absolute/XIPU MCP.app" --config-output "/absolute/mcp-config.json"');
  } else {
    try {
      const result = await configureMcp(parseArguments(process.argv.slice(2)));
      console.log(`MCP JSON exported: ${result.exportPath}`);
      if (result.client === 'config-only') console.log('No client configuration was changed. Import the exported JSON into your local stdio MCP client.');
      else console.log(`${result.client}: ${result.changed ? 'configured' : 'already configured'} (${result.configPath}). Reload MCP or restart the client to load the server.`);
      if (result.backupPath) console.log(`Original client configuration backup: ${result.backupPath}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
