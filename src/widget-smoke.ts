import { app, BrowserWindow, Menu } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Isolated native acceptance host: never opens account storage or school sessions. */
export async function runWidgetSmoke() {
  await app.whenReady();
  const load = createRequire(path.join(app.getAppPath(), 'package.json'));
  const addonPath = app.isPackaged
    ? path.join(process.resourcesPath, 'widget-bridge.node')
    : path.join(__dirname, 'native', 'widget-bridge.node');
  const bridge = load(addonPath) as { reloadTimelines: () => boolean; isSupported: () => boolean };
  if (typeof bridge.reloadTimelines !== 'function' || !bridge.isSupported()) throw new Error('原生桥接接口缺失或系统不支持。');
  const window = new BrowserWindow({
    width: 580, height: 360, title: 'DDL 原生小组件验收',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const render = (requested = false) => window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:15px/1.8 -apple-system,BlinkMacSystemFont,sans-serif;padding:30px;color:#203b32;background:#f3f6f1}h1{font-size:24px}small{color:#62756c}</style><h1>DDL 原生小组件验收</h1><p>原生 WidgetCenter 桥接已加载。</p><p>请在桌面「编辑小组件」中添加 XIPU MCP 的方形和长方形 DDL。</p><p>${requested ? '已向 WidgetCenter 请求刷新。' : '应用菜单「请求刷新小组件」可触发验收刷新。'}</p><small>此模式不读取账户、密码、邮箱或学校会话。</small></html>`));
  const reload = () => { bridge.reloadTimelines(); console.log('Widget reload requested'); void render(true); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'XIPU MCP', submenu: [{ label: '请求刷新小组件', click: reload }, { role: 'quit', label: '退出验收' }] },
  ]));
  app.on('open-url', event => { event.preventDefault(); window.show(); window.focus(); });
  app.on('window-all-closed', () => app.quit());
  await render();
  console.log('Widget smoke host ready');
}
