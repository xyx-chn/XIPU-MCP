#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (!['--arch', '--smoke-cache', '--check'].includes(name)) throw new Error(`Unknown widget build option: ${name}`);
  if (options.has(name)) throw new Error(`Duplicate widget build option: ${name}`);
  if (name === '--check') { options.set(name, true); continue; }
  const input = args[++index];
  if (!input || input.startsWith('--')) throw new Error(`Missing value for ${name}`);
  options.set(name, input);
}
const arch = options.get('--arch') ?? 'arm64';
const run = (command, argv, options = {}) => execFileSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
const capture = (command, argv) => execFileSync(command, argv, { cwd: root, encoding: 'utf8' }).trim();
const escapeXML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

if (process.platform !== 'darwin' || process.arch !== 'arm64' || arch !== 'arm64') {
  throw new Error('The local widget build requires an Apple Silicon Mac. Use the base installer on other systems.');
}
const macVersion = Number(capture('/usr/bin/sw_vers', ['-productVersion']).split('.')[0]);
if (macVersion < 14) throw new Error('Desktop widgets require macOS 14 or newer. Use the base installer on macOS 13.');
const smokeCache = options.get('--smoke-cache');
if (smokeCache && (!path.resolve(smokeCache).startsWith('/private/tmp/xipu-widget-smoke-') || path.basename(smokeCache) !== 'snapshot.json')) {
  throw new Error('--smoke-cache must be /private/tmp/xipu-widget-smoke-<id>/snapshot.json. The build never writes this fixture.');
}
let sdk;
try {
  const xcode = capture('/usr/bin/xcodebuild', ['-version']);
  sdk = capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  capture('/usr/bin/xcrun', ['swiftc', '--version']);
  console.log(`Widget toolchain: ${xcode.replace(/\n/g, ' · ')}`);
} catch {
  throw new Error('The widget requires the full Xcode app, its accepted license, and a macOS SDK. Open Xcode once, then select it with xcode-select.');
}
if (options.has('--check')) {
  console.log('Widget prerequisites available (macOS 14+, ARM64, full Xcode, macOS SDK, Swift).');
  process.exit(0);
}

const out = path.join(root, 'build', smokeCache ? 'native-smoke' : 'native');
const moduleCache = path.join(out, 'module-cache');
const appex = path.join(out, 'XIPUDeadlines.appex');
const contents = path.join(appex, 'Contents');
await mkdir(path.join(contents, 'MacOS'), { recursive: true });
await mkdir(moduleCache, { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bundleID = smokeCache ? 'edu.xipu.mcp.widgetsmoke.Deadlines' : `${pkg.build.appId}.Deadlines`;
const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${escapeXML(bundleID)}</string>
  <key>CFBundleExecutable</key><string>XIPUDeadlines</string>
  <key>CFBundleName</key><string>XIPUDeadlines</string>
  <key>CFBundleDisplayName</key><string>XIPU 截止时间</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${escapeXML(pkg.version)}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
  ${smokeCache ? `<key>XIPUWidgetSmokeSnapshotPath</key><string>${escapeXML(path.resolve(smokeCache))}</string>` : ''}
</dict></plist>\n`;
await writeFile(path.join(contents, 'Info.plist'), info);
await writeFile(path.join(contents, 'PkgInfo'), 'XPC!????');
const entitlements = path.join(out, 'widget-entitlements.plist');
if (smokeCache) {
  const directory = path.dirname(path.resolve(smokeCache)) + '/';
  await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.temporary-exception.files.absolute-path.read-only</key>
<array><string>${escapeXML(directory)}</string></array></dict></plist>\n`);
} else {
  await writeFile(entitlements, await readFile(path.join(root, 'native/widget/entitlements.plist')));
}
run('/usr/bin/xcrun', ['swiftc', '-sdk', sdk, '-module-cache-path', moduleCache, '-target', 'arm64-apple-macosx14.0', '-parse-as-library', '-O',
  '-module-name', 'XIPUDeadlines', '-application-extension',
  // Match Xcode's app-extension product type. Starting at Swift's normal _main
  // registers the Widget but exits before serving ExtensionKit descriptors.
  '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
  'native/widget/DeadlineSnapshot.swift', 'native/widget/XIPUDeadlines.swift',
  '-o', path.join(contents, 'MacOS/XIPUDeadlines')]);
run('/usr/bin/xcrun', ['swiftc', '-sdk', sdk, '-module-cache-path', moduleCache, '-target', 'arm64-apple-macosx13.0', '-O', '-emit-library',
  '-module-name', 'XIPUWidgetBridge', 'native/bridge/WidgetBridge.swift',
  '-Xlinker', '-install_name', '-Xlinker', '@rpath/libXIPUWidgetBridge.dylib',
  '-o', path.join(out, 'libXIPUWidgetBridge.dylib')]);

// Node-API is ABI stable. The official Node runtime archive already used by the
// installer includes its public C headers; no node-gyp or extra download is needed.
const caches = (await readdir(path.join(root, '.cache')).catch(() => [])).filter(name => /^node-v.*-darwin-arm64$/.test(name)).sort().reverse();
let headers = path.join(root, 'runtime/arm64/include/node');
try { await access(path.join(headers, 'node_api.h'), constants.R_OK); } catch { headers = undefined; }
for (const cache of caches) {
  if (headers) break;
  const candidate = path.join(root, '.cache', cache, 'include/node');
  try { await access(path.join(candidate, 'node_api.h'), constants.R_OK); headers = candidate; break; } catch {}
}
if (!headers) throw new Error('Node-API headers are missing. Run npm run runtime -- arm64 before building the widget.');
run('/usr/bin/xcrun', ['clang', '-isysroot', sdk, '-target', 'arm64-apple-macosx13.0', '-O2', '-bundle',
  '-undefined', 'dynamic_lookup', '-I', headers, 'native/bridge/widget-bridge.c',
  '-L', out, '-lXIPUWidgetBridge', '-Wl,-rpath,@loader_path', '-Wl,-rpath,@loader_path/../Frameworks',
  '-o', path.join(out, 'widget-bridge.node')]);
for (const artifact of [path.join(out, 'libXIPUWidgetBridge.dylib'), path.join(out, 'widget-bridge.node')]) {
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', artifact]);
}
run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlements, appex]);
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appex]);
await writeFile(path.join(out, 'metadata.json'), JSON.stringify({ arch, bundleID, kind: 'XIPUDeadlines', smokeCache: smokeCache ?? null, minimumSystemVersion: '14.0' }, null, 2) + '\n');
console.log(`Widget built and ad-hoc signed: ${appex}`);
