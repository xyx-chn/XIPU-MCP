const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const native = process.env.XIPU_WIDGET_SMOKE === '1' ? 'native-smoke' : 'native';
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const extension = path.join(app, 'Contents/PlugIns/XIPUDeadlines.appex');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--entitlements',
    path.join(context.packager.projectDir, 'build', native, 'widget-entitlements.plist'), extension], { stdio: 'inherit' });
};
