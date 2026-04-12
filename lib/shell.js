const os = require('os');
const path = require('path');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellQuoteRemotePath(filePath) {
  if (!filePath || filePath === '~') return '~';
  if (filePath.startsWith('~/')) return `~/${shellQuote(filePath.slice(2))}`;
  return shellQuote(filePath);
}

function buildRemoteCdCommand(workDir) {
  return `cd -- ${shellQuoteRemotePath(workDir || '~')}`;
}

function expandHomeDir(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

module.exports = { shellQuote, shellQuoteRemotePath, buildRemoteCdCommand, expandHomeDir };
