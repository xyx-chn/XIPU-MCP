#!/bin/bash
# Build a local Apple Silicon App and configure one explicitly selected client.
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash scripts/install.sh --client codex|claude-desktop|cursor|config-only [options]
  --app-dir DIR    Install in DIR (default: ~/Applications; no sudo).
  --with-widget    Also compile the macOS 14+ DDL desktop widget (full Xcode required).
  --no-open        Do not open the account settings window after installation.
  --help          Show this help.

Bootstraps a checksum-pinned local Node toolchain, runs npm ci, typecheck and
tests, builds an ARM .app, installs it and checks all nine MCP tools.
Only the chosen client's xipu-mcp entry is configured. No school/mail credentials
are requested or written by this script. Existing client configuration is backed up.
HELP
}

XIPU_CLIENT=''
XIPU_APP_DIR="${HOME}/Applications"
XIPU_OPEN=1
XIPU_WITH_WIDGET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --client|--app-dir)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --client) XIPU_CLIENT=$2 ;;
        --app-dir) XIPU_APP_DIR=$2 ;;
      esac
      shift 2 ;;
    --no-open) XIPU_OPEN=0; shift ;;
    --with-widget) XIPU_WITH_WIDGET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$XIPU_CLIENT" in
  codex|claude-desktop|cursor|config-only) ;;
  *) echo 'Choose --client codex, claude-desktop, cursor or config-only.' >&2; exit 2 ;;
esac
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
  echo 'Requires an Apple Silicon Mac running a native ARM terminal (macOS 13+).' >&2; exit 1;
}
XIPU_MAC_MAJOR=$(/usr/bin/sw_vers -productVersion | cut -d. -f1)
[ "$XIPU_MAC_MAJOR" -ge 13 ] || { echo 'Requires macOS 13 or newer.' >&2; exit 1; }
if [ "$XIPU_WITH_WIDGET" -eq 1 ]; then
  [ "$XIPU_MAC_MAJOR" -ge 14 ] || { echo '--with-widget requires macOS 14 or newer; omit it for the macOS 13 App.' >&2; exit 1; }
  if ! /usr/bin/xcodebuild -version >/dev/null 2>&1; then
    echo '--with-widget requires full Xcode. Install/open Xcode, complete its first-launch setup and select its developer directory. The installer does not accept licenses or install Xcode.' >&2
    exit 1
  fi
fi
case "$XIPU_APP_DIR" in
  /*) ;;
  *) echo '--app-dir must be an absolute path.' >&2; exit 2 ;;
esac

XIPU_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$XIPU_ROOT"
XIPU_NODE_VERSION=v22.23.3
XIPU_NODE_SHA=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53
XIPU_NODE_NAME="node-${XIPU_NODE_VERSION}-darwin-arm64"
XIPU_CACHE="${XIPU_ROOT}/.cache"
XIPU_ARCHIVE="${XIPU_CACHE}/${XIPU_NODE_NAME}.tar.gz"
XIPU_TOOLCHAIN="${XIPU_CACHE}/${XIPU_NODE_NAME}"
mkdir -p "$XIPU_CACHE"

echo "Preparing local Node ${XIPU_NODE_VERSION} (system Node is unchanged)…"
if [ ! -f "$XIPU_ARCHIVE" ] || [ "$(/usr/bin/shasum -a 256 "$XIPU_ARCHIVE" | cut -d' ' -f1)" != "$XIPU_NODE_SHA" ]; then
  XIPU_PART="${XIPU_ARCHIVE}.part"
  trap 'rm -f "$XIPU_PART"' EXIT
  /usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --location --retry 3 --retry-all-errors --connect-timeout 20 \
    --max-time 600 --silent --show-error \
    "https://nodejs.org/dist/${XIPU_NODE_VERSION}/${XIPU_NODE_NAME}.tar.gz" \
    --output "$XIPU_PART"
  [ "$(/usr/bin/shasum -a 256 "$XIPU_PART" | cut -d' ' -f1)" = "$XIPU_NODE_SHA" ] || {
    echo 'Node archive checksum mismatch; stopping.' >&2; exit 1;
  }
  mv "$XIPU_PART" "$XIPU_ARCHIVE"
  trap - EXIT
fi
# Re-extract from the verified archive, also replacing a damaged local cache.
rm -rf "$XIPU_TOOLCHAIN"
/usr/bin/tar -xzf "$XIPU_ARCHIVE" -C "$XIPU_CACHE"
export PATH="${XIPU_TOOLCHAIN}/bin:${PATH}"
"${XIPU_TOOLCHAIN}/bin/node" -e 'if(process.arch!=="arm64"||process.version!=="v22.23.3")process.exit(1)'
if [ "$XIPU_WITH_WIDGET" -eq 1 ]; then node scripts/build-widget.mjs --check --arch arm64; fi
node scripts/install-app.mjs --check-running

echo 'Installing locked dependencies and running checks…'
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm ci --include=dev --no-fund --no-audit
npm run typecheck
npm run build
npm test

# Reuse the exact verified bootstrap binary in the distributed App. There is no
# second Node download and no assumption that the machine has npm installed.
node --input-type=module <<'NODE'
import {mkdir,copyFile,writeFile,chmod,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const from='.cache/node-v22.23.3-darwin-arm64';
await mkdir('runtime/arm64',{recursive:true});
for(const [source,target] of [['bin/node','node'],['LICENSE','LICENSE']]) {
  await copyFile(`${from}/${source}`,`runtime/arm64/${target}`);
}
await chmod('runtime/arm64/node',0o755);
await chmod('scripts/xipu-mcp',0o755);
await writeFile('runtime/arm64/metadata.json',JSON.stringify({version:'v22.23.3',arch:'arm64',archiveSha256:'23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',nodeSha256:createHash('sha256').update(await readFile('runtime/arm64/node')).digest('hex')}));
NODE
npm run electron-runtime -- arm64
# Installing .app directly avoids requiring DMG creation tools or a signing key.
XIPU_BUILT_APP="${XIPU_ROOT}/dist/mac-arm64/XIPU MCP.app"
if [ "$XIPU_WITH_WIDGET" -eq 1 ]; then
  node scripts/build-widget.mjs --arch arm64
  XIPU_WIDGET_SMOKE=0 XIPU_WIDGET_OUTPUT="${XIPU_ROOT}/dist/widget-local" CSC_IDENTITY_AUTO_DISCOVERY=false \
    npm exec -- electron-builder --mac dir --arm64 \
    --config scripts/widget-local.config.cjs --config.electronDist=runtime/electron/arm64
  XIPU_BUILT_APP="${XIPU_ROOT}/dist/widget-local/mac-arm64/XIPU MCP.app"
else
  CSC_IDENTITY_AUTO_DISCOVERY=false npm exec -- electron-builder --mac dir --arm64 --config.electronDist=runtime/electron/arm64
fi

XIPU_INSTALLED="${XIPU_APP_DIR%/}/XIPU MCP.app"
if [ "$XIPU_WITH_WIDGET" -eq 1 ]; then
  node scripts/install-app.mjs --source "$XIPU_BUILT_APP" --destination "$XIPU_INSTALLED" --require-widget
else
  node scripts/install-app.mjs --source "$XIPU_BUILT_APP" --destination "$XIPU_INSTALLED"
fi
node scripts/smoke-mcp.mjs "${XIPU_INSTALLED}/Contents/Resources/xipu-mcp"
node scripts/setup-mcp.mjs --client "$XIPU_CLIENT" --app "$XIPU_INSTALLED" --config-output "${XIPU_ROOT}/dist/mcp-config.json"
if [ "$XIPU_OPEN" -eq 1 ]; then /usr/bin/open "$XIPU_INSTALLED"; fi
echo "Installed: ${XIPU_INSTALLED}"
if [ "$XIPU_CLIENT" = config-only ]; then
  echo 'MCP JSON exported; register it with your chosen client to complete integration.'
else
  echo 'MCP client configured. Reload your client if its tools are not visible.'
fi
echo 'First use: enter school/mail settings yourself in the App, then connect school.'
if [ "$XIPU_WITH_WIDGET" -eq 1 ]; then
  echo 'DDL widget compiled locally. In the App open 截止时间 and enable the widget; then right-click the desktop, choose 编辑小组件 and find XIPU 截止时间.'
fi
