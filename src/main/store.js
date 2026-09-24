'use strict';
// Persistência simples em JSON (substitui o electron-store, que hoje é ESM-only).
// Grava de forma atômica: escreve num arquivo temporário e renomeia.

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults, ...this._read() };
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  get(key, fallback) {
    return this.data[key] === undefined ? fallback : this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Falha ao salvar configurações:', err);
    }
  }
}

module.exports = { JsonStore };
