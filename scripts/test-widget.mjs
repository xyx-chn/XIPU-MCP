#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Native widget tests require macOS and the Swift toolchain. The regular npm test remains platform independent.');
if (process.getuid?.() === 0) throw new Error('Run native widget tests without sudo; the tests verify denied file permissions.');
const major = Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]);
if (major < 14) throw new Error('Native widget tests require macOS 14 or newer.');
const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!arch) throw new Error('Native widget tests require an ARM64 or x64 Mac.');

const directory = await mkdtemp('/private/tmp/xipu-widget-smoke-tests-');
const contents = path.join(directory, 'SnapshotTests.app', 'Contents');
const binary = path.join(contents, 'MacOS', 'SnapshotTests');
try {
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>edu.xipu.snapshot-tests</string>
  <key>CFBundleExecutable</key><string>SnapshotTests</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>XIPUWidgetSmokeSnapshotPath</key><string>${directory}/snapshot.json</string>
</dict></plist>\n`);
  execFileSync('/usr/bin/xcrun', ['swiftc', '-target', `${arch}-apple-macosx14.0`, '-parse-as-library',
    '-module-cache-path', path.join(directory, 'module-cache'),
    'native/widget/DeadlineSnapshot.swift', 'native/tests/SnapshotTests.swift', '-o', binary],
  { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [], { cwd: root, stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
