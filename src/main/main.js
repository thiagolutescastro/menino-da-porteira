'use strict';
// Processo principal: janela, IPC entre interface e módulos, e comportamento ao fechar.

const { app, BrowserWindow, ipcMain, clipboard, shell, dialog, Menu } = require('electron');
const path = require('path');
const { JsonStore } = require('./store');
const { CliManager } = require('./cli-manager');
const { TunnelManager } = require('./tunnel-manager');

const APP_NAME = 'Hospedar Sistema Local Aberto';
app.setName(APP_NAME);
// Pasta de dados alternativa (usada pelo modo simulado: npm run start:mock).
if (process.env.HSLA_USER_DATA) app.setPath('userData', process.env.HSLA_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('br.com.hospedarsistemalocal.app');

// Uma instância só: duas instâncias disputariam os mesmos processos de túnel.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let store;
let cli;
let tunnels;
let quitting = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Envolve os handlers: a interface sempre recebe { ok, data } ou { ok:false, error } legível.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 820,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links externos nunca abrem dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', onWindowClose);

  // Hook de verificação visual: HSLA_SCREENSHOT=arquivo.png tira um print e fecha.
  if (process.env.HSLA_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.HSLA_SCREENSHOT, img.toPNG());
        quitting = true;
        app.quit();
      }, Number(process.env.HSLA_SCREENSHOT_DELAY || 6000));
    });
  }
}

async function onWindowClose(event) {
  if (quitting) return;
  const active = tunnels.activeCount();
  if (!active) {
    await tunnels.stopAll();
    return;
  }
  event.preventDefault();

  let action = store.get('closeAction', 'ask');
  if (action === 'ask') {
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      title: APP_NAME,
      message: `Há ${active} túnel(is) ativo(s).`,
      detail: 'Manter em segundo plano: os túneis continuam no ar depois de fechar o app e aparecem de novo quando você abri-lo.\n\nEncerrar todos: para todos os túneis antes de sair.',
      buttons: ['Manter em segundo plano', 'Encerrar todos', 'Cancelar'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Lembrar minha escolha',
      noLink: true,
    });
    if (response === 2) return;
    action = response === 0 ? 'keep' : 'kill';
    if (checkboxChecked) store.set('closeAction', action);
  }

  quitting = true;
  if (action === 'keep') tunnels.detachAll();
  else await tunnels.stopAll();
  app.quit();
}

function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('Endereço inválido.');
  return shell.openExternal(url);
}

function registerIpc() {
  // CLI
  handle('cli:status', () => cli.detect());
  handle('cli:install', () => cli.install((p) => send('cli:progress', p)));
  handle('cli:update', () => cli.update((p) => send('cli:progress', p)));
  handle('cli:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Selecione o executável devtunnel',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Executável', extensions: ['exe'] }] : [],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return cli.useExecutable(res.filePaths[0]);
  });

  // Autenticação
  handle('auth:status', () => cli.userShow());
  handle('auth:login', async (provider) => {
    const result = await cli.login(provider, (info) => {
      send('auth:device-code', info);
      openExternal(info.url).catch(() => {});
    });
    if (result.cancelled) return { loggedIn: false, cancelled: true };
    const status = await cli.userShow();
    if (!status.loggedIn) {
      throw new Error(result.output ? `O login não foi concluído.\n${result.output.slice(-600)}` : 'O login não foi concluído.');
    }
    return status;
  });
  handle('auth:cancel', () => cli.cancelLogin());
  handle('auth:logout', () => cli.logout());

  // Túneis
  handle('tunnels:list', () => tunnels.list());
  handle('tunnels:add', (port, isPublic) => tunnels.add(port, isPublic));
  handle('tunnels:stop', (id) => tunnels.stop(id));
  handle('tunnels:restart', (id) => tunnels.restart(id));
  handle('tunnels:visibility', (id, isPublic) => tunnels.setVisibility(id, isPublic));
  handle('tunnels:log', (id) => tunnels.getLog(id));
  handle('recent:list', () => tunnels.recent());
  handle('recent:forget', (port) => tunnels.forgetRecent(port));

  // Utilidades
  handle('clipboard:write', (text) => clipboard.writeText(String(text)));
  handle('shell:open', (url) => openExternal(url));
  handle('settings:get', () => ({ closeAction: store.get('closeAction', 'ask'), cliPath: cli.path, logsDir: tunnels.logsDir }));
  handle('settings:set', (patch) => {
    if (patch && ['ask', 'keep', 'kill'].includes(patch.closeAction)) store.set('closeAction', patch.closeAction);
    return { closeAction: store.get('closeAction', 'ask') };
  });
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  store = new JsonStore(path.join(dataDir, 'config.json'), { closeAction: 'ask', recentPorts: [], tunnels: [] });
  cli = new CliManager({ store, appDataDir: app.getPath('appData') });
  tunnels = new TunnelManager({ cli, store, logsDir: path.join(dataDir, 'logs') });

  cli.on('outdated', (msg) => send('cli:outdated', msg));
  tunnels.on('outdated', (msg) => send('cli:outdated', msg));
  tunnels.on('update', (list) => send('tunnels:update', list));

  registerIpc();
  await tunnels.restore(); // readota túneis deixados em segundo plano
  createWindow();
  tunnels.startPolling();
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());
