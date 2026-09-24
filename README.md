# Hospedar Sistema Local Aberto

App desktop (Windows e Linux) para expor servidores locais com o **Microsoft Dev Tunnels** (`devtunnel`),
com uma interface parecida com o painel "Portas" do VS Code, sem precisar usar o terminal.

- Instala a CLI `devtunnel` automaticamente na primeira abertura.
- Login com conta Microsoft ou GitHub (o código de verificação aparece no app e o navegador abre sozinho).
- Vários túneis ao mesmo tempo, um processo por porta.
- Mostra qual processo está escutando em cada porta local.
- Público/Privado, Copiar URL, Abrir, Ver log, Parar.
- Ao fechar, pergunta se deve manter os túneis em segundo plano. Quando você reabre o app, ele encontra esses túneis de novo.
- Guarda as portas usadas recentemente para reabrir com um clique.

## Rodar em desenvolvimento

Requer **Node.js 20+**.

```bash
npm install
npm start
```

> Se `node_modules/electron/dist` não existir depois do `npm install`, rode `node node_modules/electron/install.js`.

### Modo simulado (sem conta e sem rede)

```bash
npm run start:mock
```

Usa `scripts/mock-devtunnel.js` no lugar da CLI real e uma pasta de dados separada. Serve para testar a interface
sem criar túneis de verdade. O login simulado conclui sozinho em 5 segundos.

## Gerar instaladores

```bash
npm run dist:win     # dist/*.exe (instalador NSIS)
npm run dist:linux   # dist/*.AppImage e dist/*.deb
```

Gere cada instalador no sistema correspondente: o AppImage e o .deb precisam ser feitos no Linux. O workflow
`.github/workflows/build.yml` gera os dois no GitHub Actions (rode manualmente ou crie uma tag `v*`).
Para trocar o ícone, edite `scripts/make-icon.js` e rode `npm run icon`.

## Como funciona

```
src/
  main/
    main.js            janela, IPC e comportamento ao fechar
    cli-manager.js     localizar/instalar/atualizar a CLI; login (device code), logout, user show
    tunnel-manager.js  processos "devtunnel host", visibilidade, polling, readoção após reabrir
    port-inspector.js  processo escutando em cada porta (netstat+tasklist / ss / lsof)
    downloader.js      download via net.fetch do Electron (respeita o proxy do sistema)
    store.js           persistência em JSON (config.json na pasta de dados do app)
  preload/preload.js   ponte segura (contextBridge) para a interface
  renderer/            HTML/CSS/JS da interface
scripts/               ícone, simulador da CLI e lançador do modo simulado
```

**Instalação da CLI.** O app procura, nesta ordem: o caminho salvo, o PATH, a pasta do próprio app e as pastas do winget.
Se não encontrar:
- **Windows:** tenta `winget install Microsoft.devtunnel`. Se não der certo, baixa `https://aka.ms/TunnelsCliDownload/win-x64`
  para `%APPDATA%\hospedar-sistema-local\bin\devtunnel.exe`.
- **Linux:** baixa `https://aka.ms/TunnelsCliDownload/linux-x64` para `~/.local/bin/devtunnel` e dá `chmod +x`. Se o download
  falhar, usa o script oficial `curl -sL https://aka.ms/DevTunnelCliInstall | bash`.

Se tudo falhar, o app mostra os comandos de instalação manual e deixa você escolher o executável.

**Túneis em segundo plano.** Cada `devtunnel host -p <porta>` roda desanexado do app, com a saída gravada num arquivo de
log. Por isso o túnel continua funcionando depois que o app fecha. Quando o app reabre, ele encontra o processo pelo PID
salvo, confere que é mesmo o devtunnel e volta a ler o log.

**Público/Privado.** Primeiro o app tenta mudar o acesso com o túnel no ar (`devtunnel access create --anonymous` /
`access reset`), o que mantém a URL. Se não conseguir confirmar a mudança, reinicia o túnel com ou sem `--allow-anonymous`,
e nesse caso a URL muda.

**Parar.** O app encerra o processo e roda `devtunnel delete <id> -f`. Isso evita que túneis temporários fiquem sobrando
na conta, que tem um limite de túneis.

## Dicas

- **Túneis públicos acessados pelo navegador** mostram uma página de aviso do Dev Tunnels na primeira visita. Para chamadas
  de API, envie o cabeçalho `X-Tunnel-Skip-AntiPhishing-Page: true`.
- **Túneis privados** só podem ser acessados pela mesma conta que está logada no app.
- **Linux:** o login do devtunnel guarda o token pelo `libsecret`. Em distros mínimas pode ser preciso instalar
  `libsecret-1-0` e `gnome-keyring`.
- **Para mudar o que acontece ao fechar o app**, abra Configurações (ícone de engrenagem).
