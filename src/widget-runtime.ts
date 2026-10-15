import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';

export function loadWidgetRuntime(): {available:boolean; message:string; reload:()=>void} {
  if (process.platform !== 'darwin' || !app.isPackaged) return {
    available:false, message:'请安装支持桌面小组件的 macOS 版本。', reload:()=>{},
  };
  try {
    const load = createRequire(path.join(app.getAppPath(),'package.json'));
    const bridge = load(path.join(process.resourcesPath,'widget-bridge.node')) as {isSupported:()=>boolean;reloadTimelines:()=>boolean};
    if (!bridge.isSupported()) return {available:false,message:'桌面小组件需要 macOS 14 或更新版本。',reload:()=>{}};
    return {available:true,message:'支持方形和长方形桌面小组件。',reload:()=>{try {bridge.reloadTimelines();} catch {console.error('无法请求小组件刷新。');}}};
  } catch {
    return {available:false,message:'此版本未包含桌面小组件，请安装支持小组件的版本。',reload:()=>{}};
  }
}
