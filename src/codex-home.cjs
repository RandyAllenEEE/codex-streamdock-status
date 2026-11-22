'use strict';

const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

function codexHome() {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
}

module.exports = { codexHome };
