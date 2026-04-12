let mainWindow = null;
const activeClaudeProcs = new Map();

module.exports = {
  getMainWindow: () => mainWindow,
  setMainWindow: (win) => { mainWindow = win; },
  activeClaudeProcs,
};
