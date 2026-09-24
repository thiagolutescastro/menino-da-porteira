'use strict';
// Interface: fluxo de inicialização (CLI -> login -> painel), tabela de túneis, modais e avisos.

// "api" é global: exposto pelo preload via contextBridge (window.api).
const I = window.ICONS;
const $ = (id) => document.getElementById(id);

const state = {
  cli: null,
  account: null,
  tunnels: [],
  recent: [],
  busy: new Set(), // ids de túneis com ação em andamento
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLATFORM = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[api.platform] || api.platform;

// ---------- Telas ----------

function showScreen(name) {
  for (const s of ['boot', 'install', 'login', 'main']) $(`screen-${s}`).classList.toggle('hidden', s !== name);
}

function bootMessage(text) {
  $('boot-text').textContent = text;
  showScreen('boot');
}

// ---------- Toasts e modais ----------

function toast(message, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="msg"></span><button class="icon-btn small" aria-label="Fechar">${I.close}</button>`;
  el.querySelector('.msg').textContent = message;
  const remove = () => el.remove();
  el.querySelector('button').onclick = remove;
  $('toasts').appendChild(el);
  if (ms) setTimeout(remove, kind === 'error' ? ms * 2 : ms);
}

function modal({ title, body, actions = [], wide = false, onClose }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2></h2><button class="icon-btn small" data-close aria-label="Fechar">${I.close}</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  backdrop.querySelector('h2').textContent = title;
  const bodyEl = backdrop.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('[data-close]').onclick = close;

  const foot = backdrop.querySelector('.modal-foot');
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    b.onclick = () => (a.onClick ? a.onClick(close, b) : close());
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  $('modal-root').appendChild(backdrop);
  (foot.querySelector('.primary') || backdrop.querySelector('[data-close]')).focus();
  return { close, body: bodyEl, el: backdrop };
}

function confirmDialog({ title, message, confirmLabel = 'Confirmar', kind = 'primary' }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: `<p>${message}</p>`,
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: 'Cancelar', kind: 'ghost' },
        { label: confirmLabel, kind, onClick: (close) => { answered = true; close(); resolve(true); } },
      ],
    });
  });
}

// ---------- Etapa 1: CLI ----------

async function boot() {
  bootMessage('Verificando devtunnel CLI...');
  const res = await api.cli.status();
  if (res.ok && res.data.found) {
    setCli(res.data);
    return checkAuth();
  }
  return installCli();
}

function setCli(cli) {
  state.cli = cli;
  updateStatusbar();
}

async function installCli() {
  showScreen('install');
  $('install-title').textContent = 'Instalando devtunnel CLI...';
  $('install-message').textContent = 'A CLI do Microsoft Dev Tunnels não foi encontrada. Instalando automaticamente (só na primeira vez).';
  $('install-log').textContent = '';
  $('install-error').classList.add('hidden');
  $('install-progress').classList.remove('hidden');
  setProgress(null);

  const res = await api.cli.install();
  if (res.ok) {
    setCli(res.data);
    toast(`devtunnel ${res.data.version} instalado com sucesso.`, 'success');
    return checkAuth();
  }
  showInstallError(res.error);
}

function setProgress(percent) {
  const p = $('install-progress');
  p.classList.toggle('indeterminate', percent == null);
  p.querySelector('.bar').style.width = percent == null ? '' : `${percent}%`;
}

function appendInstallLog(line) {
  const log = $('install-log');
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

api.cli.onProgress((p) => {
  if (p.message) {
    $('install-message').textContent = p.message;
    $('boot-text').textContent = p.message;
  }
  if (p.stage === 'download') setProgress(p.percent);
  else if (p.stage) setProgress(null);
  if (p.log) appendInstallLog(p.log);
});

function showInstallError(message) {
  $('install-title').textContent = 'Não foi possível instalar o devtunnel';
  $('install-message').textContent = '';
  $('install-progress').classList.add('hidden');
  $('install-error').classList.remove('hidden');
  $('install-error-text').textContent = message;
  $('install-manual').textContent = api.platform === 'win32'
    ? 'winget install Microsoft.devtunnel\n\n# ou baixe o executável:\nhttps://aka.ms/TunnelsCliDownload/win-x64'
    : 'curl -sL https://aka.ms/DevTunnelCliInstall | bash';
}

$('install-retry').onclick = () => installCli();
$('install-docs').onclick = () => api.shell.open('https://learn.microsoft.com/azure/developer/dev-tunnels/get-started');
$('install-pick').onclick = async () => {
  const res = await api.cli.pick();
  if (!res.ok) return toast(res.error, 'error');
  if (!res.data) return;
  setCli(res.data);
  checkAuth();
};

// ---------- Etapa 2: Login ----------

async function checkAuth() {
  bootMessage('Verificando login...');
  const res = await api.auth.status();
  if (res.ok && res.data.loggedIn) {
    setAccount(res.data);
    return showMain();
  }
  setAccount(null);
  $('login-error').classList.toggle('hidden', res.ok);
  if (!res.ok) $('login-error').textContent = res.error;
  showScreen('login');
}

function setAccount(acc) {
  state.account = acc;
  $('account').classList.toggle('hidden', !acc);
  if (!acc) return;
  $('account-name').textContent = acc.user;
  $('account-provider').textContent = `via ${acc.provider}`;
  $('account-avatar').textContent = (acc.user.match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
}

async function login(provider) {
  $('login-error').classList.add('hidden');
  const body = document.createElement('div');
  body.innerHTML = `<div class="waiting"><div class="spinner"></div><span>Solicitando código de verificação...</span></div>`;
  let finished = false;
  const dlg = modal({
    title: provider === 'github' ? 'Entrar com GitHub' : 'Entrar com Microsoft',
    body,
    onClose: () => { if (!finished) api.auth.cancel(); },
    actions: [{ label: 'Cancelar', kind: 'ghost' }],
  });

  const off = api.auth.onDeviceCode((info) => {
    body.innerHTML = `
      <p>O navegador foi aberto. Na página de login, digite o código abaixo:</p>
      <div class="device-code"><span id="dc-code"></span>
        <button class="icon-btn" id="dc-copy" title="Copiar código">${I.copy}</button></div>
      <p class="muted">Página: <a class="url-link" id="dc-url"></a></p>
      <div class="waiting"><div class="spinner"></div><span>Aguardando você concluir o login no navegador...</span></div>`;
    body.querySelector('#dc-code').textContent = info.code;
    const link = body.querySelector('#dc-url');
    link.textContent = info.url;
    link.onclick = () => api.shell.open(info.url);
    body.querySelector('#dc-copy').onclick = async () => {
      await api.clipboard.write(info.code);
      toast('Código copiado.', 'success', 2000);
    };
  });

  const res = await api.auth.login(provider);
  off();
  finished = true;
  dlg.close();
  if (!res.ok) {
    $('login-error').textContent = res.error;
    $('login-error').classList.remove('hidden');
    return;
  }
  if (res.data.cancelled) return;
  setAccount(res.data);
  toast(`Conectado como ${res.data.user}.`, 'success');
  showMain();
}

$('login-microsoft').onclick = () => login('microsoft');
$('login-github').onclick = () => login('github');

$('btn-logout').onclick = async () => {
  const active = state.tunnels.filter((t) => t.status !== 'error').length;
  const ok = await confirmDialog({
    title: 'Sair da conta',
    message: active
      ? `Você tem ${active} túnel(is) ativo(s). Eles continuam rodando até serem parados, mas novas ações exigirão login. Deseja sair?`
      : 'Deseja sair da conta do Dev Tunnels?',
    confirmLabel: 'Sair',
  });
  if (!ok) return;
  const res = await api.auth.logout();
  if (!res.ok) return toast(res.error, 'error');
  setAccount(null);
  showScreen('login');
};

// ---------- Etapa 3: Painel de túneis ----------

async function showMain() {
  showScreen('main');
  const [list, recent] = await Promise.all([api.tunnels.list(), api.recent.list()]);
  if (list.ok) state.tunnels = list.data;
  if (recent.ok) state.recent = recent.data;
  render();
}

api.tunnels.onUpdate((list) => {
  const before = new Map(state.tunnels.map((t) => [t.id, t]));
  state.tunnels = list;
  // Avisa quando um túnel sai do ar ou fica pronto.
  for (const t of list) {
    const prev = before.get(t.id);
    if (!prev || prev.status === t.status) continue;
    if (t.status === 'error' && t.error) toast(`Porta ${t.port}: ${t.error}`, 'error');
    if (t.status === 'running' && ['starting', 'restarting'].includes(prev.status) && t.url) {
      toast(`Porta ${t.port} disponível em ${t.url}`, 'success');
    }
  }
  render();
});

function render() {
  renderRows();
  renderRecent();
  updateStatusbar();
}

function renderRows() {
  const rows = state.tunnels;
  $('count').textContent = rows.length;
  $('empty').classList.toggle('hidden', rows.length > 0);
  $('rows').innerHTML = rows.map(rowHtml).join('');
}

const STATUS_LABEL = {
  running: 'Ativo', starting: 'Iniciando', restarting: 'Reiniciando', stopping: 'Encerrando', error: 'Com erro',
};

function rowHtml(t) {
  const busy = state.busy.has(t.id) || ['stopping', 'restarting'].includes(t.status);
  const dis = busy ? 'disabled' : '';
  const id = esc(t.id);

  let address;
  if (t.status === 'error') {
    address = `<span class="err-text" title="${esc(t.error)}">${esc(t.error || 'O túnel parou.')}</span>`;
  } else if (t.url && t.status === 'running') {
    address = `<div class="url-cell">
        <a class="url-link" data-action="open" data-id="${id}" title="Abrir ${esc(t.url)}">${esc(t.url)}</a>
        ${t.inspectUrl ? `<button class="icon-btn small" data-action="inspect" data-id="${id}" title="Inspecionar tráfego">${I.inspect}</button>` : ''}
      </div>`;
  } else {
    const label = { starting: 'Iniciando túnel...', restarting: 'Reiniciando túnel...', stopping: 'Encerrando...' }[t.status] || '...';
    address = `<div class="inline-status"><div class="spinner"></div><span>${label}</span></div>
      ${t.error ? `<span class="sub warn">${esc(t.error)}</span>` : ''}`;
  }

  let proc;
  if (t.process) {
    proc = `<div class="proc-cell" title="${esc(t.process.name || 'Processo')} (PID ${esc(t.process.pid)})">
      <span class="proc-name">${esc(t.process.name || 'Processo desconhecido')}</span>
      ${t.process.pid ? `<span class="proc-pid">PID ${esc(t.process.pid)}</span>` : ''}</div>`;
  } else if (t.listening === false) {
    proc = `<span class="proc-none" title="Nenhum servidor está escutando em localhost:${t.port}. Quem acessar a URL verá erro até você iniciar o servidor.">${I.warn}Nada escutando</span>`;
  } else {
    proc = '<span class="muted">—</span>';
  }

  const vis = t.public
    ? `<button class="vis-pill public" data-action="visibility" data-id="${id}" ${dis} title="Público: qualquer pessoa com a URL acessa. Clique para tornar privado.">${I.globe}Público</button>`
    : `<button class="vis-pill" data-action="visibility" data-id="${id}" ${dis} title="Privado: só a sua conta acessa. Clique para tornar público.">${I.lock}Privado</button>`;

  const actions = t.status === 'error'
    ? `<button class="btn" data-action="restart" data-id="${id}" ${dis}>${I.refresh}Tentar novamente</button>
       <button class="btn" data-action="log" data-id="${id}">${I.log}Log</button>
       <button class="btn danger" data-action="stop" data-id="${id}" ${dis}>${I.trash}Remover</button>`
    : `<button class="btn" data-action="copy" data-id="${id}" ${t.url ? '' : 'disabled'} title="Copiar URL">${I.copy}Copiar URL</button>
       <button class="btn" data-action="visibility" data-id="${id}" ${dis}>${t.public ? `${I.lock}Tornar Privado` : `${I.globe}Tornar Público`}</button>
       <button class="icon-btn" data-action="log" data-id="${id}" title="Ver log do túnel">${I.log}</button>
       <button class="btn danger" data-action="stop" data-id="${id}" ${dis} title="Parar túnel">${I.stop}Parar</button>`;

  return `<tr>
    <td><div class="port-cell" title="${STATUS_LABEL[t.status] || t.status}">
      <span class="dot ${esc(t.status)}"></span>${t.port}
      ${t.adopted ? '<span class="tag" title="Túnel mantido em segundo plano desde a última sessão">bg</span>' : ''}
    </div></td>
    <td>${address}</td>
    <td>${proc}</td>
    <td>${vis}</td>
    <td><div class="actions">${actions}</div></td>
  </tr>`;
}

$('rows').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const t = state.tunnels.find((x) => x.id === el.dataset.id);
  if (!t) return;
  const action = el.dataset.action;

  if (action === 'open') return api.shell.open(t.url);
  if (action === 'inspect') return api.shell.open(t.inspectUrl);
  if (action === 'copy') {
    const res = await api.clipboard.write(t.url);
    return res.ok ? toast('URL copiada para a área de transferência.', 'success', 2000) : toast(res.error, 'error');
  }
  if (action === 'log') return showLog(t);
  if (action === 'visibility') return toggleVisibility(t);
  if (action === 'restart') return withBusy(t, () => api.tunnels.restart(t.id));
  if (action === 'stop') {
    const res = await withBusy(t, () => api.tunnels.stop(t.id));
    if (res.ok) {
      toast(`Túnel da porta ${t.port} encerrado.`, 'info', 2500);
      refreshRecent();
    }
  }
});

async function withBusy(t, fn) {
  state.busy.add(t.id);
  renderRows();
  const res = await fn();
  state.busy.delete(t.id);
  renderRows();
  if (!res.ok) toast(res.error, 'error');
  return res;
}

async function toggleVisibility(t) {
  const makePublic = !t.public;
  if (makePublic) {
    const ok = await confirmDialog({
      title: `Tornar a porta ${t.port} pública?`,
      message: `Qualquer pessoa com a URL poderá acessar <strong>localhost:${t.port}</strong> sem fazer login.<br><br>
        <span class="muted">Dica: navegadores veem uma página de aviso na primeira visita. Clientes de API podem pulá-la
        enviando o cabeçalho <code>X-Tunnel-Skip-AntiPhishing-Page: true</code>.</span>`,
      confirmLabel: 'Tornar público',
    });
    if (!ok) return;
  }
  const res = await withBusy(t, () => api.tunnels.setVisibility(t.id, makePublic));
  if (!res.ok) return;
  const label = makePublic ? 'pública' : 'privada';
  if (res.data.mode === 'updated') toast(`Porta ${t.port} agora é ${label} (URL mantida).`, 'success');
  else if (res.data.mode === 'restarted') toast(`Túnel da porta ${t.port} reiniciado como ${label}. A URL pode ter mudado.`, 'info');
}

async function showLog(t) {
  const pre = document.createElement('pre');
  pre.className = 'log';
  pre.textContent = 'Carregando...';
  const load = async () => {
    const res = await api.tunnels.log(t.id);
    pre.textContent = res.ok ? res.data : res.error;
    pre.scrollTop = pre.scrollHeight;
  };
  modal({
    title: `Log do túnel — porta ${t.port}`,
    body: pre,
    wide: true,
    actions: [
      { label: 'Atualizar', onClick: () => load() },
      { label: 'Fechar', kind: 'primary' },
    ],
  });
  load();
}

// ---------- Adicionar porta ----------

$('btn-add').innerHTML = `${I.plus}Adicionar Porta`;
$('btn-add').onclick = () => openAddForm();

function openAddForm(port) {
  $('add-form').classList.remove('hidden');
  $('add-hint').textContent = '';
  $('add-port').value = port || '';
  $('add-port').focus();
}

function closeAddForm() {
  $('add-form').classList.add('hidden');
  $('add-form').reset();
}

$('add-cancel').onclick = closeAddForm;
$('add-form').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddForm(); });
$('add-public').onchange = (e) => {
  $('add-hint').textContent = e.target.checked ? 'Qualquer pessoa com a URL poderá acessar.' : '';
};

$('add-form').onsubmit = async (e) => {
  e.preventDefault();
  const port = Number($('add-port').value);
  const ok = await addTunnel(port, $('add-public').checked);
  if (ok) closeAddForm();
};

async function addTunnel(port, isPublic) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast('Informe uma porta válida entre 1 e 65535.', 'error');
    return false;
  }
  const res = await api.tunnels.add(port, isPublic);
  if (!res.ok) {
    toast(res.error, 'error');
    return false;
  }
  refreshRecent();
  return true;
}

// ---------- Portas recentes ----------

async function refreshRecent() {
  const res = await api.recent.list();
  if (res.ok) state.recent = res.data;
  renderRecent();
}

function renderRecent() {
  const active = new Set(state.tunnels.map((t) => t.port));
  const items = state.recent.filter((r) => !active.has(r.port));
  const box = $('recent');
  box.classList.toggle('hidden', items.length === 0);
  if (!items.length) return;
  box.innerHTML = `<span class="muted">Recentes:</span>
    ${items.map((r) => `<span class="chip" data-port="${r.port}" data-public="${r.public ? 1 : 0}" role="button" tabindex="0"
        title="Expor a porta ${r.port} novamente (${r.public ? 'público' : 'privado'})">
        ${r.public ? I.globe : I.lock}${r.port}
        <span class="x" data-forget="${r.port}" title="Esquecer">${I.close}</span></span>`).join('')}
    ${items.length > 1 ? '<button class="btn small ghost" id="restore-all">Restaurar todas</button>' : ''}`;
}

$('recent').addEventListener('click', async (e) => {
  const forget = e.target.closest('[data-forget]');
  if (forget) {
    const res = await api.recent.forget(Number(forget.dataset.forget));
    if (res.ok) state.recent = res.data;
    return renderRecent();
  }
  if (e.target.closest('#restore-all')) {
    const active = new Set(state.tunnels.map((t) => t.port));
    for (const r of state.recent.filter((x) => !active.has(x.port))) await addTunnel(r.port, r.public);
    return;
  }
  const chip = e.target.closest('.chip');
  if (chip) addTunnel(Number(chip.dataset.port), chip.dataset.public === '1');
});
$('recent').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('chip')) e.target.click();
});

// ---------- Configurações, CLI desatualizada, rodapé ----------

$('btn-settings').innerHTML = I.gear;
$('btn-settings').onclick = async () => {
  const res = await api.settings.get();
  const s = res.ok ? res.data : { closeAction: 'ask' };
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="section-title">Ao fechar o app com túneis ativos</p>
    <div class="radio-list">
      <label><input type="radio" name="close" value="ask"><span>Perguntar sempre</span></label>
      <label><input type="radio" name="close" value="keep"><span>Manter os túneis em segundo plano</span></label>
      <label><input type="radio" name="close" value="kill"><span>Encerrar todos os túneis</span></label>
    </div>
    <p class="section-title">devtunnel CLI</p>
    <div class="kv">
      <span>Versão</span><span>${esc(state.cli?.version || '—')}</span>
      <span>Executável</span><span>${esc(s.cliPath || state.cli?.path || '—')}</span>
      <span>Logs</span><span>${esc(s.logsDir || '—')}</span>
    </div>
    <div class="row-actions">
      <button class="btn" id="set-update">${I.refresh}Atualizar CLI</button>
      <button class="btn ghost" id="set-pick">Usar outro executável...</button>
    </div>`;
  body.querySelector(`input[value="${s.closeAction}"]`).checked = true;
  body.querySelectorAll('input[name="close"]').forEach((r) => {
    r.onchange = () => api.settings.set({ closeAction: r.value });
  });
  body.querySelector('#set-update').onclick = (e) => updateCli(e.currentTarget);
  body.querySelector('#set-pick').onclick = async () => {
    const r = await api.cli.pick();
    if (!r.ok) return toast(r.error, 'error');
    if (r.data) { setCli(r.data); toast(`Usando devtunnel ${r.data.version}.`, 'success'); }
  };
  modal({ title: 'Configurações', body, actions: [{ label: 'Fechar', kind: 'primary' }] });
};

async function updateCli(button) {
  if (button) button.disabled = true;
  toast('Atualizando a CLI devtunnel...', 'info', 3000);
  const res = await api.cli.update();
  if (button) button.disabled = false;
  if (!res.ok) return toast(res.error, 'error');
  setCli(res.data);
  $('banner').classList.add('hidden');
  toast(`devtunnel atualizado (versão ${res.data.version}).`, 'success');
}

api.cli.onOutdated((msg) => {
  $('banner-text').textContent = `A CLI devtunnel parece desatualizada: ${msg}`;
  $('banner').classList.remove('hidden');
});
$('banner-update').onclick = (e) => updateCli(e.currentTarget);
$('banner-close').innerHTML = I.close;
$('banner-close').onclick = () => $('banner').classList.add('hidden');

function updateStatusbar() {
  const running = state.tunnels.filter((t) => t.status === 'running').length;
  const errors = state.tunnels.filter((t) => t.status === 'error').length;
  $('status-left').textContent = state.cli
    ? `${running} túnel(is) ativo(s)${errors ? ` · ${errors} com erro` : ''}`
    : '';
  $('status-right').textContent = [state.cli?.version && `devtunnel ${state.cli.version}`, PLATFORM].filter(Boolean).join(' · ');
}

boot();
