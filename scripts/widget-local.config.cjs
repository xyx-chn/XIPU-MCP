const path = require('node:path');
const base = require('../package.json').build;
const smoke = process.env.XIPU_WIDGET_SMOKE === '1';
const native = smoke ? 'build/native-smoke' : 'build/native';

// This profile is intentionally separate from future Developer ID distribution.
// All local components use the same ad-hoc identity, and library validation is off.
module.exports = {
  ...base,
  appId: smoke ? 'edu.xipu.mcp.widgetsmoke' : base.appId,
  productName: smoke ? 'XIPU Widget Smoke' : base.productName,
  directories: { ...base.directories, output: process.env.XIPU_WIDGET_OUTPUT ?? 'dist/widget-local' },
  protocols: [{ name: 'XIPU MCP DDL', schemes: ['xipu-mcp'] }],
  extraFiles: [
    ...(base.extraFiles ?? []),
    { from: `${native}/XIPUDeadlines.appex`, to: 'PlugIns/XIPUDeadlines.appex' },
    { from: `${native}/libXIPUWidgetBridge.dylib`, to: 'Frameworks/libXIPUWidgetBridge.dylib' },
  ],
  extraResources: [...base.extraResources, { from: `${native}/widget-bridge.node`, to: 'widget-bridge.node' }],
  mac: {
    ...base.mac,
    identity: '-',
    hardenedRuntime: false,
    preAutoEntitlements: false,
    notarize: false,
    signIgnore: ['Contents/PlugIns/'],
  },
  afterPack: path.join(__dirname, 'widget-local-after-pack.cjs'),
  afterSign: path.join(__dirname, 'widget-local-after-sign.cjs'),
};
