'use strict';
// Descobre qual processo está escutando em cada porta TCP local.
// Windows: netstat -ano + tasklist. Linux: ss -ltnpH (fallback: lsof).

const fs = require('fs');
const { run } = require('./cli-manager');

const IS_WIN = process.platform === 'win32';
let cache = { at: 0, data: new Map() };

async function listListeners() {
  if (Date.now() - cache.at < 2500) return cache.data;
  let data = new Map();
  try {
    data = IS_WIN ? await listWindows() : await listUnix();
  } catch (err) {
    console.error('Falha ao inspecionar portas:', err);
  }
  cache = { at: Date.now(), data };
  return data;
}

async function listWindows() {
  const map = new Map();
  const net = await run('netstat', ['-ano', '-p', 'TCP'], { timeout: 15000 });
  const net6 = await run('netstat', ['-ano', '-p', 'TCPv6'], { timeout: 15000 });
  const pids = new Set();

  for (const line of `${net.stdout}\n${net6.stdout}`.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Proto  Local  Externo  Estado  PID — o "Estado" é traduzido (LISTENING/ESCUTANDO...),
    // então identificamos sockets em escuta pelo endereço externo ":0".
    if (cols.length < 5 || !/^TCP/i.test(cols[0]) || !/:0$/.test(cols[2])) continue;
    const port = Number(cols[1].slice(cols[1].lastIndexOf(':') + 1));
    const pid = Number(cols[cols.length - 1]);
    if (!port || map.has(port)) continue;
    map.set(port, { pid, name: null });
    if (pid) pids.add(pid);
  }

  if (pids.size) {
    const tl = await run('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 15000 });
    const names = new Map();
    for (const line of tl.stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) names.set(Number(m[2]), m[1]);
    }
    for (const info of map.values()) {
      info.name = info.pid === 4 ? 'System' : names.get(info.pid) || null;
    }
  }
  return map;
}

async function listUnix() {
  const map = new Map();
  const ss = await run('ss', ['-ltnpH'], { timeout: 10000 });
  if (ss.code === 0) {
    for (const line of ss.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[3];
      const port = Number(local.slice(local.lastIndexOf(':') + 1));
      if (!port || map.has(port)) continue;
      const m = line.match(/\("([^"]+)",pid=(\d+)/);
      map.set(port, { pid: m ? Number(m[2]) : null, name: m ? m[1] : null });
    }
    return map;
  }
  const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 10000 });
  let pid = null;
  let name = null;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) name = line.slice(1);
    else if (line.startsWith('n')) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      if (port && !map.has(port)) map.set(port, { pid, name });
    }
  }
  return map;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Nome do executável de um PID (para não "adotar" um PID reutilizado por outro programa).
async function processName(pid) {
  if (!isAlive(pid)) return null;
  if (IS_WIN) {
    const res = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10000 });
    const m = res.stdout.match(/^"([^"]+)","(\d+)"/m);
    return m ? m[1] : null;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    const res = await run('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 });
    return res.stdout.trim() || null;
  }
}

module.exports = { listListeners, isAlive, processName };
