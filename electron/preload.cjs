// 在渲染进程里安全地暴露桌面能力。页面通过 window.desktop 使用。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform, // 'win32' | 'darwin' | 'linux'

  // 串口选择
  chooseSerialPort: (portId) => ipcRenderer.send('serial:choose', portId),
  onSerialList: (cb) => ipcRenderer.on('serial:list', (_e, list) => cb(list)),

  // TCP（WiFi ELM327）
  tcpConnect: (host, port) => ipcRenderer.invoke('tcp:connect', { host, port }),
  tcpWrite: (id, data) => ipcRenderer.send('tcp:write', { id, data }),
  tcpClose: (id) => ipcRenderer.send('tcp:close', { id }),
  onTcpData: (cb) => ipcRenderer.on('tcp:data', (_e, m) => cb(m)),
  onTcpClose: (cb) => ipcRenderer.on('tcp:close', (_e, m) => cb(m)),

  // AI 接口转发
  aiFetch: (url, headers, body) => ipcRenderer.invoke('ai:fetch', { url, headers, body }),
});
