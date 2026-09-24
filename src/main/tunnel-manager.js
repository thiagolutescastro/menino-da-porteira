'use strict';
// Gerencia os processos "devtunnel host -p <porta>": um processo filho independente por porta.
//
// Cada processo é iniciado "detached" e com stdout/stderr redirecionados para um arquivo de log
// (em vez de um pipe). Assim ele pode continuar rodando depois que o app fecha e, na próxima
// abertura, o app "readota" o processo pelo PID e continua lendo o mesmo log.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { stripAnsi } = require('./cli-manager');
const { listListeners, isAlive, processName } = require('./port-inspector');

const IS_WIN = process.platform === 'win32';
const POLL_MS = 1500;
const PORT_SCAN_MS = 4000;
const MAX_LOG = 64 * 1024;
const MAX_RECENT = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TunnelManager extends EventEmitter {
  constructor({ cli, store, logsDir }) {
    super();
    this.cli = cli;
    this.store = store;
    this.logsDir = logsDir;
    this.tunnels = new Map();
    this.seq = 0;
    this.lastSnapshot = '';
    this.lastPortScan = 0;
    this.timer = null;
  }

  // ---------- Ciclo de vida ----------

  async restore() {
    const saved = this.store.get('tunnels', []);
    const expected = this.cli.mockScript ? /electron|node/i : /devtunnel/i;
    for (const s of saved) {
      const name = await processName(s.pid);
      if (!name || !expected.test(name)) continue;
      const t = { ...s, child: null, adopted: true, status: 'running', logOffset: 0, logText: '', error: null };
      this.tunnels.set(t.id, t);
      this._readLog(t);
    }
    this._cleanupLogs();
    this._persist();
    this._changed();
  }

  startPolling() {
    if (!this.timer) this.timer = setInterval(() => this._tick(), POLL_MS);
    this._tick();
  }

  stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Fecha o app sem encerrar os túneis: eles seguem rodando e são readotados depois.
  detachAll() {
    this.stopPolling();
    this._persist();
  }

  async stopAll() {
    this.stopPolling();
    await Promise.all([...this.tunnels.keys()].map((id) => this.stop(id)));
  }

  activeCount() {
    return [...this.tunnels.values()].filter((t) => t.status !== 'error').length;
  }

  // ---------- Ações ----------

  list() {
    return [...this.tunnels.values()]
      .sort((a, b) => a.port - b.port)
      .map((t) => ({
        id: t.id,
        port: t.port,
        public: !!t.public,
        status: t.status,
        url: t.url || null,
        inspectUrl: t.inspectUrl || null,
        tunnelId: t.tunnelId || null,
        error: t.error || null,
        pid: t.pid || null,
        process: t.process || null,
        listening: t.listening,
        adopted: !!t.adopted,
        startedAt: t.startedAt,
      }));
  }

  add(portValue, isPublic) {
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Informe uma porta válida entre 1 e 65535.');
    }
    if ([...this.tunnels.values()].some((t) => t.port === port)) {
      throw new Error(`A porta ${port} já está sendo exposta por um túnel desta lista.`);
    }
    const t = { id: `t${Date.now().toString(36)}${this.seq++}`, port, public: !!isPublic };
    this.tunnels.set(t.id, t);
    this._remember(port, t.public);
    this._start(t);
    return this.list().find((x) => x.id === t.id);
  }

  async stop(id) {
    const t = this._get(id);
    t.stopping = true;
    t.status = 'stopping';
    this._changed();
    await this._kill(t);
    this._deleteRemote(t.tunnelId);
    this._readLog(t);
    this.tunnels.delete(id);
    fs.rm(t.logFile || '', { force: true }, () => {});
    this._persist();
    this._changed();
  }

  async restart(id) {
    const t = this._get(id);
    t.stopping = true;
    t.status = 'restarting';
    this._changed();
    await this._kill(t);
    this._deleteRemote(t.tunnelId);
    fs.rm(t.logFile || '', { force: true }, () => {});
    t.stopping = false;
    this._start(t);
  }

  // Tenta alterar o acesso do túnel ao vivo (mantém a URL). Se não der, reinicia com/sem --allow-anonymous.
  async setVisibility(id, isPublic) {
    const t = this._get(id);
    isPublic = !!isPublic;
    if (t.public === isPublic) return { mode: 'unchanged' };

    if (t.status === 'running' && t.tunnelId && (await this._updateAccess(t, isPublic))) {
      t.public = isPublic;
      this._remember(t.port, isPublic);
      this._persist();
      this._changed();
      return { mode: 'updated' };
    }
    t.public = isPublic;
    this._remember(t.port, isPublic);
    await this.restart(id);
    return { mode: 'restarted' };
  }

  getLog(id) {
    const t = this._get(id);
    this._readLog(t);
    return stripAnsi(t.logText || '').trim() || '(sem saída ainda)';
  }

  recent() {
    return this.store.get('recentPorts', []);
  }

  forgetRecent(port) {
    this.store.set('recentPorts', this.recent().filter((r) => r.port !== Number(port)));
    return this.recent();
  }

  // ---------- Internos ----------

  _get(id) {
    const t = this.tunnels.get(id);
    if (!t) throw new Error('Túnel não encontrado (talvez já tenha sido encerrado).');
    return t;
  }

  _start(t) {
    fs.mkdirSync(this.logsDir, { recursive: true });
    Object.assign(t, {
      status: 'starting', url: null, inspectUrl: null, tunnelId: null, error: null,
      adopted: false, stopping: false, logOffset: 0, logText: '', startedAt: Date.now(),
      logFile: path.join(this.logsDir, `tunnel-${t.port}-${Date.now()}.log`),
    });

    const args = ['host', '-p', String(t.port)];
    if (t.public) args.push('--allow-anonymous');

    const fd = fs.openSync(t.logFile, 'a');
    let child;
    try {
      child = this.cli.spawn(args, { detached: true, stdio: ['ignore', fd, fd] });
    } catch (err) {
      t.status = 'error';
      t.error = `Não foi possível iniciar o devtunnel: ${err.message}`;
      this._changed();
      return;
    } finally {
      fs.closeSync(fd);
    }

    t.child = child;
    t.pid = child.pid;
    child.on('error', (err) => {
      if (t.child !== child) return;
      t.status = 'error';
      t.error = `Não foi possível iniciar o devtunnel: ${err.message}`;
      this._changed();
    });
    child.on('exit', (code) => this._onExit(t, child, code));
    child.unref();
    this._persist();
    this._changed();
  }

  _onExit(t, child, code) {
    if (t.child !== child) return; // processo antigo de um restart
    t.child = null;
    if (t.stopping) return;
    this._readLog(t);
    t.status = 'error';
    t.error = describeFailure(t.logText, code);
    this._persist();
    this._changed();
  }

  async _kill(t) {
    const pid = t.pid;
    if (!isAlive(pid)) return;
    try {
      if (IS_WIN) {
        if (t.child) t.child.kill();
        else process.kill(pid);
      } else {
        // SIGINT permite que o devtunnel apague o túnel temporário sozinho.
        try { process.kill(-pid, 'SIGINT'); } catch { process.kill(pid, 'SIGINT'); }
      }
    } catch { /* já morreu */ }
    for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100);
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }

  // Um "kill" não dá chance ao devtunnel de remover o túnel temporário no serviço;
  // removemos explicitamente para não acumular túneis e estourar o limite da conta.
  _deleteRemote(tunnelId) {
    if (!tunnelId) return;
    this.cli.exec(['delete', tunnelId, '-f'], { timeout: 30000 }).catch(() => {});
  }

  async _updateAccess(t, isPublic) {
    const id = t.tunnelId;
    const port = String(t.port);
    try {
      if (isPublic) {
        const r = await this.cli.exec(['access', 'create', id, '--anonymous']);
        if (r.code !== 0) return false;
      } else {
        const r = await this.cli.exec(['access', 'reset', id]);
        if (r.code !== 0) return false;
        await this.cli.exec(['access', 'reset', id, '-p', port]);
      }
      const tunnelAcl = await this.cli.exec(['access', 'list', id]);
      if (tunnelAcl.code !== 0) return false;
      const portAcl = await this.cli.exec(['access', 'list', id, '-p', port]);
      const anon = /^\s*\+?\s*anonymous\b/im;
      const hasAnon = anon.test(tunnelAcl.stdout) || (portAcl.code === 0 && anon.test(portAcl.stdout));
      return hasAnon === isPublic;
    } catch {
      return false;
    }
  }

  _readLog(t) {
    if (!t.logFile) return;
    let size;
    try {
      size = fs.statSync(t.logFile).size;
    } catch {
      return;
    }
    if (size < t.logOffset) t.logOffset = 0; // arquivo recriado
    if (size === t.logOffset) return;

    const start = Math.max(t.logOffset, size - MAX_LOG);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(t.logFile, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    t.logOffset = size;
    t.logText = (t.logText + buf.toString('utf8')).slice(-MAX_LOG);
    this._parse(t);
  }

  _parse(t) {
    const text = stripAnsi(t.logText);
    const urls = (text.match(/https:\/\/[^\s,'"<>]+/g) || [])
      .map((u) => u.replace(/[.,;)]+$/, ''))
      .filter((u) => /devtunnels\.ms/i.test(u));
    const inspect = urls.find((u) => /-inspect\./i.test(u));
    const hosts = urls.filter((u) => u !== inspect);
    const url = hosts.find((u) => new RegExp(`-${t.port}\\.`).test(u)) || hosts[0];
    if (url) t.url = url;
    if (inspect) t.inspectUrl = inspect;

    const ready = text.match(/Ready to accept connections for tunnel:?\s*([\w.-]+)/i);
    if (ready) t.tunnelId = ready[1].replace(/\.$/, '');
    else if (url && !t.tunnelId) {
      // https://abc123-3000.brs.devtunnels.ms  ->  abc123.brs
      const m = url.match(/^https:\/\/([a-z0-9]+)(?:-\d+)?\.([a-z0-9]+)\.devtunnels\.ms/i);
      if (m) t.tunnelId = `${m[1]}.${m[2]}`;
    }
    if ((ready || url) && ['starting', 'restarting'].includes(t.status)) t.status = 'running';

    if (/(a\s+)?newer version|no longer supported|upgrade required|please update/i.test(text) && !t.warnedOutdated) {
      t.warnedOutdated = true;
      this.emit('outdated', `Túnel da porta ${t.port}: a CLI devtunnel informou que precisa ser atualizada.`);
    }
  }

  async _tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const t of this.tunnels.values()) {
        this._readLog(t);
        // Processos readotados não emitem "exit"; checamos pelo PID.
        if (!t.child && !t.stopping && t.status !== 'error' && !isAlive(t.pid)) {
          t.status = 'error';
          t.error = describeFailure(t.logText, null) || 'O processo do túnel foi encerrado.';
          this._persist();
        }
        if (t.status === 'starting' && Date.now() - t.startedAt > 45000 && !t.slowWarned) {
          t.slowWarned = true;
          t.error = 'O túnel está demorando para iniciar. Verifique sua conexão ou veja o log.';
        }
        if (t.status === 'running' && t.slowWarned && t.error?.startsWith('O túnel está demorando')) t.error = null;
      }
      if (this.tunnels.size && Date.now() - this.lastPortScan > PORT_SCAN_MS) {
        this.lastPortScan = Date.now();
        const listeners = await listListeners();
        for (const t of this.tunnels.values()) {
          const info = listeners.get(t.port);
          t.listening = !!info;
          t.process = info ? { pid: info.pid, name: info.name } : null;
        }
      }
      this._changed();
    } catch (err) {
      console.error('Falha no polling de túneis:', err);
    } finally {
      this.ticking = false;
    }
  }

  _changed() {
    const list = this.list();
    const snap = JSON.stringify(list);
    if (snap === this.lastSnapshot) return;
    this.lastSnapshot = snap;
    this.emit('update', list);
  }

  _persist() {
    const alive = [...this.tunnels.values()].filter((t) => t.pid && t.status !== 'error' && !t.stopping);
    this.store.set('tunnels', alive.map((t) => ({
      id: t.id, port: t.port, public: t.public, pid: t.pid, url: t.url, inspectUrl: t.inspectUrl,
      tunnelId: t.tunnelId, logFile: t.logFile, startedAt: t.startedAt,
    })));
  }

  _remember(port, isPublic) {
    const list = this.recent().filter((r) => r.port !== port);
    list.unshift({ port, public: isPublic, lastUsed: Date.now() });
    this.store.set('recentPorts', list.slice(0, MAX_RECENT));
  }

  _cleanupLogs() {
    const inUse = new Set([...this.tunnels.values()].map((t) => t.logFile));
    try {
      for (const f of fs.readdirSync(this.logsDir)) {
        const full = path.join(this.logsDir, f);
        if (!inUse.has(full)) fs.rmSync(full, { force: true });
      }
    } catch { /* pasta ainda não existe */ }
  }
}

// Converte a saída do devtunnel em uma mensagem amigável.
function describeFailure(logText, code) {
  const text = stripAnsi(logText || '');
  const rules = [
    [/not logged in|login required|please (sign|log) ?in|unauthori[sz]ed|\b401\b/i,
      'Você não está autenticado no devtunnel. Faça login novamente.'],
    [/(maximum|limit).{0,40}tunnels|too many tunnels|quota/i,
      'Limite de túneis da conta atingido. Encerre túneis antigos (devtunnel list / devtunnel delete).'],
    [/already (being )?hosted|already in use|address already in use|conflict/i,
      'Esta porta/túnel já está em uso por outro host do devtunnel.'],
    [/(a\s+)?newer version|no longer supported|upgrade required|please update/i,
      'A CLI devtunnel está desatualizada. Use "Atualizar CLI" no menu.'],
    [/could not resolve|name resolution|network|timed? ?out|ECONN|proxy/i,
      'Falha de rede ao conectar no serviço Dev Tunnels. Verifique sua internet/proxy.'],
  ];
  for (const [re, msg] of rules) if (re.test(text)) return msg;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /error|erro|fail|exception|invalid/i.test(l));
  if (errLine) return errLine.slice(0, 300);
  if (code === null || code === undefined) return null;
  return `O devtunnel encerrou inesperadamente (código ${code}).${lines.length ? ` Última mensagem: ${lines[lines.length - 1].slice(0, 200)}` : ''}`;
}

module.exports = { TunnelManager };
