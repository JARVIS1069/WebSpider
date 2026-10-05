'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webSpider', {
  info: () => ipcRenderer.invoke('app:info'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  checkRobots: (url) => ipcRenderer.invoke('robots:check', url),
  capture: (webContentsId) => ipcRenderer.invoke('capture', webContentsId),
  save: (payload) => ipcRenderer.invoke('save', payload),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  autotestDone: (info) => ipcRenderer.send('autotest-done', info),
  log: (m) => ipcRenderer.send('log', String(m)),
  onHotkey: (cb) => ipcRenderer.on('hotkey', () => cb()),
  onAutotest: (cb) => ipcRenderer.on('autotest', () => cb())
});
