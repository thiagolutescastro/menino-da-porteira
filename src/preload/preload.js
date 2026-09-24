'use strict';
// Ponte segura entre a interface (renderer) e o processo principal.
// Só estas funções ficam visíveis em window.api — nada de Node.js direto no renderer.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (callback) => {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  cli: {
    status: () => invoke('cli:status'),
    install: () => invoke('cli:install'),
    update: () => invoke('cli:update'),
    pick: () => invoke('cli:pick'),
    onProgress: on('cli:progress'),
    onOutdated: on('cli:outdated'),
  },
  auth: {
    status: () => invoke('auth:status'),
    login: (provider) => invoke('auth:login', provider),
    cancel: () => invoke('auth:cancel'),
    logout: () => invoke('auth:logout'),
    onDeviceCode: on('auth:device-code'),
  },
  tunnels: {
    list: () => invoke('tunnels:list'),
    add: (port, isPublic) => invoke('tunnels:add', port, isPublic),
    stop: (id) => invoke('tunnels:stop', id),
    restart: (id) => invoke('tunnels:restart', id),
    setVisibility: (id, isPublic) => invoke('tunnels:visibility', id, isPublic),
    log: (id) => invoke('tunnels:log', id),
    onUpdate: on('tunnels:update'),
  },
  recent: {
    list: () => invoke('recent:list'),
    forget: (port) => invoke('recent:forget', port),
  },
  clipboard: { write: (text) => invoke('clipboard:write', text) },
  shell: { open: (url) => invoke('shell:open', url) },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
});
