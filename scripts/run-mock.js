'use strict';
// Abre o app usando o simulador da CLI e uma pasta de dados separada,
// para não misturar com seus túneis e configurações reais.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.HSLA_DEVTUNNEL_MOCK = path.join(__dirname, 'mock-devtunnel.js');
env.HSLA_USER_DATA = env.HSLA_USER_DATA || path.join(os.tmpdir(), 'hsla-mock-userdata');

const child = spawn(electron, [path.join(__dirname, '..')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
