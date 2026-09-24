'use strict';
// Simulador da CLI devtunnel para testar a interface sem conta nem rede.
// Usado por "npm run start:mock". Imita a saída dos comandos que o app usa.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = process.env.HSLA_MOCK_STATE || path.join(os.tmpdir(), 'hsla-mock-state');
fs.mkdirSync(dir, { recursive: true });
const loginFile = path.join(dir, 'login.json');
const aclFile = (id) => path.join(dir, `acl-${id.replace(/[^\w.-]/g, '')}`);
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const out = (s) => process.stdout.write(`${s}\n`);
const cmd = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');

if (has('--version')) {
  out('Tunnel CLI version: 1.0.1435+mock');
  out('Tunnel service URI: https://global.rel.tunnels.api.visualstudio.com/');
  process.exit(0);
}

const loggedIn = () => fs.existsSync(loginFile);

switch (true) {
  case cmd === 'user show':
    if (loggedIn()) {
      const u = JSON.parse(fs.readFileSync(loginFile, 'utf8'));
      out(`Logged in as ${u.user} using ${u.provider}.`);
    } else out('Not logged in.');
    break;

  case cmd === 'user login': {
    const github = has('-g');
    out(github
      ? 'Browse to https://github.com/login/device and enter the code: A1B2-C3D4'
      : 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code DEMO12345 to authenticate.');
    setTimeout(() => {
      const user = github ? 'demo-github' : 'demo@exemplo.com';
      fs.writeFileSync(loginFile, JSON.stringify({ user, provider: github ? 'GitHub' : 'Microsoft' }));
      out(`Logged in as ${user} using ${github ? 'GitHub' : 'Microsoft'}.`);
      process.exit(0);
    }, 5000);
    break;
  }

  case cmd === 'user logout':
    fs.rmSync(loginFile, { force: true });
    out('Logged out.');
    break;

  case args[0] === 'host': {
    if (!loggedIn()) {
      out("Error: Not logged in. Please run 'devtunnel user login'.");
      process.exit(1);
    }
    const port = args[args.indexOf('-p') + 1];
    const id = Math.random().toString(36).slice(2, 10);
    if (has('--allow-anonymous')) fs.writeFileSync(aclFile(`${id}.brs`), 'anonymous');
    setTimeout(() => {
      out(`Hosting port: ${port}`);
      out(`Connect via browser: https://${id}-${port}.brs.devtunnels.ms, https://${id}.brs.devtunnels.ms:${port}`);
      out(`Inspect network activity: https://${id}-${port}-inspect.brs.devtunnels.ms`);
      out('');
      out(`Ready to accept connections for tunnel: ${id}.brs`);
    }, 1500);
    setInterval(() => {}, 1 << 30);
    process.on('SIGINT', () => process.exit(0));
    break;
  }

  case cmd === 'access create':
    fs.writeFileSync(aclFile(args[2]), 'anonymous');
    out('+Anonymous [connect]');
    break;

  case cmd === 'access reset':
    fs.rmSync(aclFile(args[2]), { force: true });
    out('Reset access control entries.');
    break;

  case cmd === 'access list':
    out(fs.existsSync(aclFile(args[2]))
      ? `Found 1 access control entry for tunnel ${args[2]}:\n+Anonymous [connect]`
      : `No access control entries for tunnel ${args[2]}.`);
    break;

  case args[0] === 'delete':
    fs.rmSync(aclFile(args[1] || ''), { force: true });
    out(`Deleted: ${args[1]}`);
    break;

  default:
    out(`Error: comando não simulado: ${args.join(' ')}`);
    process.exit(1);
}
