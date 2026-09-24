'use strict';
// Download de arquivos usando net.fetch do Electron: usa a pilha de rede do Chromium,
// então respeita proxy do sistema (comum em redes corporativas) e segue redirects (aka.ms).

const fs = require('fs');
const { net } = require('electron');

async function downloadFile(url, dest, onProgress = () => {}) {
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download falhou (HTTP ${res.status}) em ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  const reader = res.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
      onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }

  if (received < 1024) {
    fs.rmSync(part, { force: true });
    throw new Error('O arquivo baixado é inválido (tamanho muito pequeno).');
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  return dest;
}

module.exports = { downloadFile };
