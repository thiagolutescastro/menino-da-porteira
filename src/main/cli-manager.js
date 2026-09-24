'use strict';
// Gerenciamento da CLI devtunnel: localização, instalação automática, atualização,
// execução de comandos e autenticação (user show / login / logout).

const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadFile } = require('./downloader');

const DOWNLOAD_BASE = 'https://aka.ms/TunnelsCliDownload';
const LINUX_INSTALL_SCRIPT = 'https://aka.ms/DevTunnelCliInstall';
const DOCS_URL = 'https://learn.microsoft.com/azure/developer/dev-tunnels/get-started';
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'devtunnel.exe' : 'devtunnel';
const OUTDATED_RE = /(a\s+)?newer version|new version (of .+ )?is available|no longer supported|upgrade required|please update/i;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function which(name) {
  const exts = IS_WIN ? ['', '.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* não existe */ }
    }
  }
  return null;
}

// Executa um processo e devolve { code, stdout, stderr } sem lançar em código != 0.
function run(file, args, { timeout = 30000, env, onData } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: env || process.env,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: stripAnsi(stdout || ''),
        stderr: stripAnsi(stderr || ''),
        error: err && typeof err.code !== 'number' ? err : null,
      });
    });
    if (onData) {
      child.stdout?.on('data', (d) => onData(stripAnsi(d)));
      child.stderr?.on('data', (d) => onData(stripAnsi(d)));
    }
  });
}

class CliManager extends EventEmitter {
  constructor({ store, appDataDir }) {
    super();
    this.store = store;
    this.path = null;
    this.version = null;
    this.loginChild = null;
    // Pasta própria do app para o binário (Windows: %APPDATA%/hospedar-sistema-local/bin).
    this.localBinDir = IS_WIN
      ? path.join(appDataDir, 'hospedar-sistema-local', 'bin')
      : path.join(os.homedir(), '.local', 'bin');
    // Modo de demonstração/teste: um script Node que imita a CLI (scripts/mock-devtunnel.js).
    this.mockScript = process.env.HSLA_DEVTUNNEL_MOCK || null;
  }

  // ---------- Execução ----------

  _command(args) {
    if (this.mockScript) {
      return {
        file: process.execPath,
        args: [this.mockScript, ...args],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    if (!this.path) throw new Error('A CLI devtunnel ainda não foi localizada.');
    return { file: this.path, args, env: this._env() };
  }

  _env() {
    const dir = this.path ? path.dirname(this.path) : this.localBinDir;
    return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` };
  }

  async exec(args, opts = {}) {
    const cmd = this._command(args);
    const res = await run(cmd.file, cmd.args, { env: cmd.env, ...opts });
    const all = `${res.stdout}\n${res.stderr}`;
    if (OUTDATED_RE.test(all)) this.emit('outdated', all.split('\n').find((l) => OUTDATED_RE.test(l)).trim());
    return res;
  }

  // Processo longo (host/login). O chamador decide stdio/detached.
  spawn(args, options = {}) {
    const cmd = this._command(args);
    return spawn(cmd.file, cmd.args, { windowsHide: true, env: cmd.env, ...options });
  }

  // ---------- Detecção ----------

  _candidates() {
    const list = [this.store.get('cliPath'), which('devtunnel'), path.join(this.localBinDir, EXE)];
    if (IS_WIN) {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      list.push(path.join(local, 'Microsoft', 'WinGet', 'Links', EXE));
      list.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Links', EXE));
      const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
      try {
        for (const d of fs.readdirSync(pkgs)) {
          if (d.toLowerCase().startsWith('microsoft.devtunnel')) list.push(path.join(pkgs, d, EXE));
        }
      } catch { /* winget nunca usado */ }
    } else {
      list.push(path.join(os.homedir(), 'bin', EXE), '/usr/local/bin/devtunnel', '/usr/bin/devtunnel');
    }
    return [...new Set(list.filter(Boolean))];
  }

  async _probe(file) {
    const res = await run(file, ['--version'], { timeout: 20000 });
    const out = `${res.stdout}\n${res.stderr}`;
    const m = out.match(/version:?\s*v?(\d+\.\d+[\w.+-]*)/i) || out.match(/(\d+\.\d+\.\d+[\w.+-]*)/);
    return res.code === 0 && m ? m[1] : null;
  }

  async detect() {
    if (this.mockScript) {
      const res = await this.exec(['--version']);
      this.version = (res.stdout.match(/version:?\s*(\S+)/i) || [])[1] || 'mock';
      this.path = 'mock';
      return this.status();
    }
    for (const file of this._candidates()) {
      if (!fs.existsSync(file)) continue;
      const version = await this._probe(file);
      if (version) {
        this.path = file;
        this.version = version;
        this.store.set('cliPath', file);
        // Garante que o diretório do binário está no PATH interno do app.
        const dir = path.dirname(file);
        if (!(process.env.PATH || '').split(path.delimiter).includes(dir)) {
          process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
        }
        return this.status();
      }
    }
    this.path = null;
    this.version = null;
    return this.status();
  }

  status() {
    return { found: !!this.path, path: this.path, version: this.version, platform: process.platform, docsUrl: DOCS_URL };
  }

  async useExecutable(file) {
    const version = await this._probe(file);
    if (!version) throw new Error('O arquivo selecionado não parece ser a CLI devtunnel (falha em "--version").');
    this.store.set('cliPath', file);
    return this.detect();
  }

  // ---------- Instalação ----------

  _arch() {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
  }

  async install(progress = () => {}) {
    const log = (message) => progress({ log: message });
    if (IS_WIN) await this._installWindows(progress, log);
    else if (process.platform === 'linux') await this._installLinux(progress, log);
    else await this._installMac(progress, log);

    const st = await this.detect();
    if (!st.found) throw new Error('A instalação terminou, mas o executável devtunnel não foi encontrado.');
    progress({ stage: 'done', message: `devtunnel ${st.version} instalado.` });
    return st;
  }

  async _installWindows(progress, log) {
    const winget = await run('winget', ['--version'], { timeout: 15000 });
    if (winget.code === 0) {
      progress({ stage: 'winget', message: 'Instalando devtunnel CLI via winget...' });
      const res = await run('winget', [
        'install', '--id', 'Microsoft.devtunnel', '-e', '--source', 'winget',
        '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity', '--silent',
      ], { timeout: 10 * 60000, onData: (d) => cleanLines(d).forEach(log) });
      log(`winget terminou com código ${res.code}.`);
      if ((await this.detect()).found) return;
      log('winget não disponibilizou o executável; usando download direto.');
    } else {
      log('winget não encontrado; usando download direto.');
    }
    await this._downloadBinary(`win-${this._arch()}`, progress, log);
  }

  async _installLinux(progress, log) {
    try {
      await this._downloadBinary(`linux-${this._arch()}`, progress, log);
    } catch (err) {
      log(`Download direto falhou: ${err.message}`);
      progress({ stage: 'script', message: 'Tentando o script oficial de instalação...' });
      const res = await run('bash', ['-c', `curl -sL ${LINUX_INSTALL_SCRIPT} | bash`], {
        timeout: 5 * 60000, onData: (d) => cleanLines(d).forEach(log),
      });
      if (res.code !== 0) throw new Error(`Script de instalação falhou: ${(res.stderr || res.stdout).trim()}`);
    }
  }

  async _installMac(progress, log) {
    progress({ stage: 'brew', message: 'Instalando devtunnel CLI via Homebrew...' });
    const res = await run('brew', ['install', '--cask', 'devtunnel'], { timeout: 10 * 60000, onData: (d) => cleanLines(d).forEach(log) });
    if (res.code !== 0) throw new Error('Não foi possível instalar via Homebrew.');
  }

  async _downloadBinary(target, progress, log) {
    fs.mkdirSync(this.localBinDir, { recursive: true });
    const dest = path.join(this.localBinDir, EXE);
    const url = `${DOWNLOAD_BASE}/${target}`;
    progress({ stage: 'download', message: 'Baixando devtunnel CLI...', percent: 0 });
    log(`Baixando ${url}`);

    // No Windows um .exe em uso não pode ser apagado, mas pode ser renomeado.
    if (IS_WIN && fs.existsSync(dest)) {
      const old = `${dest}.old`;
      fs.rmSync(old, { force: true });
      try { fs.renameSync(dest, old); } catch { /* segue; o download tenta substituir */ }
    }
    await downloadFile(url, dest, (p) => progress({ stage: 'download', message: 'Baixando devtunnel CLI...', percent: p.percent }));
    if (!IS_WIN) fs.chmodSync(dest, 0o755);
    log(`Salvo em ${dest}`);

    if (!(await this._probe(dest))) throw new Error('O binário baixado não executou corretamente.');
    this.store.set('cliPath', dest);
  }

  async update(progress = () => {}) {
    const log = (message) => progress({ log: message });
    if (this.mockScript) return this.detect();
    const managedByApp = this.path && path.dirname(this.path) === this.localBinDir;
    if (IS_WIN && this.path && /\\WinGet\\/i.test(this.path)) {
      progress({ stage: 'winget', message: 'Atualizando via winget...' });
      await run('winget', ['upgrade', '--id', 'Microsoft.devtunnel', '-e', '--accept-source-agreements',
        '--accept-package-agreements', '--disable-interactivity', '--silent'], { timeout: 10 * 60000, onData: (d) => cleanLines(d).forEach(log) });
    } else if (managedByApp) {
      await this._downloadBinary(`${IS_WIN ? 'win' : 'linux'}-${this._arch()}`, progress, log);
    } else {
      throw new Error(`A CLI em "${this.path}" foi instalada fora do app. Atualize-a pelo mesmo gerenciador usado na instalação.`);
    }
    return this.detect();
  }

  // ---------- Autenticação ----------

  async userShow() {
    const res = await this.exec(['user', 'show'], { timeout: 30000 });
    const out = `${res.stdout}\n${res.stderr}`.trim();
    const m = out.match(/Logged in as\s+(.+?)\s+using\s+([\w-]+)/i);
    if (m) return { loggedIn: true, user: m[1].trim(), provider: m[2].trim() };
    return { loggedIn: false, raw: out };
  }

  // Login por "device code": a CLI imprime a URL e o código, que exibimos no app.
  login(provider, onInfo) {
    this.cancelLogin();
    const args = ['user', 'login', '-d'];
    if (provider === 'github') args.push('-g');

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, output: err.message });
        return;
      }
      this.loginChild = child;
      let output = '';
      let sent = false;
      const killTimer = setTimeout(() => child.kill(), 16 * 60000); // códigos expiram em ~15 min

      const onData = (d) => {
        output += stripAnsi(d);
        const info = parseDeviceCode(output);
        if (info && !sent) {
          sent = true;
          onInfo(info);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => { output += `\n${err.message}`; });
      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (this.loginChild === child) this.loginChild = null;
        resolve({ ok: code === 0, cancelled: !!signal, output: output.trim() });
      });
    });
  }

  cancelLogin() {
    if (this.loginChild) {
      this.loginChild.kill();
      this.loginChild = null;
    }
  }

  async logout() {
    const res = await this.exec(['user', 'logout']);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || 'Falha ao sair da conta.');
  }
}

function parseDeviceCode(text) {
  const url = (text.match(/https?:\/\/[^\s"'<>]+/) || [])[0];
  const code = (text.match(/(?:enter|use)\s+(?:the\s+)?code:?\s*([A-Z0-9][A-Z0-9-]{4,})/i) || [])[1];
  if (!url || !code) return null;
  return { url: url.replace(/[.,;:)]+$/, ''), code, message: text.trim() };
}

// Remove barras de progresso/spinners da saída do winget.
function cleanLines(chunk) {
  return String(chunk)
    .split(/[\r\n]+/)
    .map((l) => l.replace(/[█▒░]+/g, '').trim())
    .filter((l) => l.length > 2 && !/^[-\\|/\s]+$/.test(l));
}

module.exports = { CliManager, stripAnsi, run, DOCS_URL };
