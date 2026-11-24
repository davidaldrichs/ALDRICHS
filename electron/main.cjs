// Electron 主进程：加载打包好的 Web 界面，并为渲染进程提供桌面专属的连接能力：
//  - TCP（WiFi 版 ELM327）：用 Node 的 net 模块
//  - 串口 / 经典蓝牙（COM 口）：用 Chromium 内置的 Web Serial，端口选择在这里处理
const { app, BrowserWindow, ipcMain } = require('electron');
const net = require('net');
const path = require('path');

const sockets = new Map();
let nextId = 1;
let pendingSerialCallback = null;
let pendingSerialPorts = [];

function createWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 860,
    minWidth: 360,
    minHeight: 600,
    title: 'MINI R 诊断',
    backgroundColor: '#0f1113',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();

  const ses = win.webContents.session;

  // 允许页面使用串口，并把选择权交给渲染进程的弹窗
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler(() => true);
  ses.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    pendingSerialCallback = callback;
    pendingSerialPorts = portList;
    win.webContents.send(
      'serial:list',
      portList.map((p) => ({
        portId: p.portId,
        portName: p.portName || p.displayName || p.deviceInstanceId || p.portId,
      })),
    );
  });

  ipcMain.on('serial:choose', (_e, portId) => {
    if (!pendingSerialCallback) return;
    const cb = pendingSerialCallback;
    pendingSerialCallback = null;
    cb(portId || ''); // '' = 取消
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/* ---------------- TCP（WiFi ELM327）---------------- */

ipcMain.handle('tcp:connect', (event, { host, port }) => {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const socket = net.createConnection({ host, port }, () => resolve(id));
    socket.setTimeout(10000, () => socket.destroy(new Error('连接超时')));
    socket.on('connect', () => socket.setTimeout(0));
    socket.on('data', (buf) => {
      event.sender.send('tcp:data', { id, data: buf.toString('utf8') });
    });
    const end = () => {
      if (sockets.delete(id)) event.sender.send('tcp:close', { id });
    };
    socket.on('close', end);
    socket.on('error', (err) => {
      if (sockets.has(id)) end();
      else reject(err);
    });
    sockets.set(id, socket);
  });
});

ipcMain.on('tcp:write', (_e, { id, data }) => {
  sockets.get(id)?.write(data);
});

ipcMain.on('tcp:close', (_e, { id }) => {
  const s = sockets.get(id);
  if (s) {
    sockets.delete(id);
    s.destroy();
  }
});

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(createWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
