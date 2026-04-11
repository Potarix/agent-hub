const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHub', {
  // Non-streaming chat
  chat: (agent, messages) => ipcRenderer.invoke('agent:chat', agent, messages),

  // Streaming chat
  chatStream: (requestId, agent, messages) => ipcRenderer.send('agent:chat-stream', requestId, agent, messages),
  onStreamChunk: (cb) => ipcRenderer.on('agent:stream-chunk', (_e, id, text) => cb(id, text)),
  onStreamDone: (cb) => ipcRenderer.on('agent:stream-done', (_e, id) => cb(id)),
  onStreamError: (cb) => ipcRenderer.on('agent:stream-error', (_e, id, err) => cb(id, err)),

  // Remove stream listeners
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('agent:stream-chunk');
    ipcRenderer.removeAllListeners('agent:stream-done');
    ipcRenderer.removeAllListeners('agent:stream-error');
  },

  // Ping agent
  ping: (agent) => ipcRenderer.invoke('agent:ping', agent),

  // Slash commands
  getSlashCommands: (provider) => ipcRenderer.invoke('agent:slash-commands', provider),
  execSlash: (agent, command) => ipcRenderer.invoke('agent:exec-slash', agent, command),

  // Auth (in-app, no terminal needed)
  authLogin: (agent) => ipcRenderer.invoke('agent:auth-login', agent),
  authStatus: (agent) => ipcRenderer.invoke('agent:auth-status', agent),
  authSendInput: (agentId, input) => ipcRenderer.invoke('agent:auth-send-input', agentId, input),
  onAuthStatus: (cb) => ipcRenderer.on('agent:auth-status', (_e, agentId, status) => cb(agentId, status)),
  onAuthOutput: (cb) => ipcRenderer.on('agent:auth-output', (_e, agentId, text) => cb(agentId, text)),
  removeAuthListeners: () => {
    ipcRenderer.removeAllListeners('agent:auth-status');
    ipcRenderer.removeAllListeners('agent:auth-output');
  },

  // Legacy (kept for compat, redirects to in-app auth)
  openAuthTerminal: (agent) => ipcRenderer.invoke('agent:open-auth-terminal', agent),

  // Theme
  getSystemTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (cb) => ipcRenderer.on('theme:changed', (_e, isDark) => cb(isDark)),
});
