import { lstat, mkdir, rename, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function statOrMissing(file) {
  try { return await lstat(file); } catch (error) { if(error.code === 'ENOENT') return undefined; throw error; }
}

/** Atomically replace only this App. Never modify userData or client settings. */
export async function installApp(source, destination, { copy = (from, to) => execFileSync('/usr/bin/ditto', [from, to]), running = isRunning } = {}) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || path.basename(destination) !== 'XIPU MCP.app') {
    throw new Error('Source/destination must be absolute; destination must be XIPU MCP.app.');
  }
  if (path.resolve(source) === path.resolve(destination)) throw new Error('Source and installed App must be different.');
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('Source App must be a real directory.');
  for (const name of ['Contents/MacOS/XIPU MCP', 'Contents/Resources/node', 'Contents/Resources/xipu-mcp']) {
    await access(path.join(source, name), constants.X_OK);
  }
  await access(path.join(source, 'Contents/Resources/bridge.cjs'));
  const existing = await statOrMissing(destination);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Installed App path is a symlink or not a directory.');
  if (await running(destination)) throw new Error('An XIPU MCP App is running, possibly from another folder. Quit it from its application menu, then run the installer again. Active downloads should finish first.');
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = path.join(parent, `.xipu-install-${randomUUID()}.app`);
  const backup = path.join(parent, `.xipu-backup-${randomUUID()}.app`);
  let backedUp = false, installed = false;
  try {
    await copy(source, stage);
    // The copied entrypoints must be usable before replacing a previous App.
    for (const name of ['Contents/MacOS/XIPU MCP', 'Contents/Resources/node', 'Contents/Resources/xipu-mcp']) {
      await access(path.join(stage, name), constants.X_OK);
    }
    if (existing) { await rename(destination, backup); backedUp = true; }
    await rename(stage, destination); installed = true;
  } catch (error) {
    if (backedUp && !installed) await rename(backup, destination);
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  // Only after a complete atomic installation can the old executable be removed.
  if (backedUp) await rm(backup, { recursive: true, force: true });
  return destination;
}

async function isRunning() {
  const output = execFileSync('/bin/ps', ['-axo', 'uid=,command='], { encoding: 'utf8' });
  if (output.split('\n').some(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && Number(match[1]) === process.getuid() && /(?:^|\/)XIPU MCP\.app\/Contents\/MacOS\/XIPU MCP(?:$|\s)/.test(match[2]);
  })) return true;
  // A development Electron instance also owns this broker, despite its generic
  // executable name. Probe only the socket; no token or App secrets are read.
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(homedir(), 'Library', 'Application Support', 'XIPU MCP', 'bridge.sock'));
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => { socket.destroy(); if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false); else reject(new Error('Cannot check the local XIPU broker; check directory/socket permissions.')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('The local XIPU broker probe timed out; close the existing App before updating.')); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void (async () => { try {
    if (process.argv.slice(2).length === 1 && process.argv[2] === '--check-running') {
      if (await isRunning()) throw new Error('An XIPU MCP App or development broker is running. Finish active downloads and quit it from its application menu before installing.');
      console.log('No existing XIPU MCP App/broker is running.');
      return;
    }
    const args = process.argv.slice(2), values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--source', '--destination'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/install-app.mjs --source <app> --destination <app>');
      values[args[i]] = args[i + 1];
    }
    if (!values['--source'] || !values['--destination']) throw new Error('Both --source and --destination are required.');
    console.log(`App installed: ${await installApp(values['--source'], values['--destination'])}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; } })();
}
