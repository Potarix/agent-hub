const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHub', {
  // Non-streaming chat
  chat: (agent, messages) => ipcRenderer.invoke('agent:chat', agent, messages),

  // Streaming chat
  chatStream: (requestId, agent, messages) => ipcRenderer.send('agent:chat-stream', requestId, agent, messages),
  onStreamChunk: (cb) => { const handler = (_e, id, text) => cb(id, text); ipcRenderer.on('agent:stream-chunk', handler); return () => ipcRenderer.removeListener('agent:stream-chunk', handler); },
  onStreamThinking: (cb) => { const handler = (_e, id, text) => cb(id, text); ipcRenderer.on('agent:stream-thinking', handler); return () => ipcRenderer.removeListener('agent:stream-thinking', handler); },
  onStreamDone: (cb) => { const handler = (_e, id, meta) => cb(id, meta); ipcRenderer.on('agent:stream-done', handler); return () => ipcRenderer.removeListener('agent:stream-done', handler); },
  onStreamError: (cb) => { const handler = (_e, id, err) => cb(id, err); ipcRenderer.on('agent:stream-error', handler); return () => ipcRenderer.removeListener('agent:stream-error', handler); },

  // Tool use activity (inline indicators during streaming)
  onStreamToolUse: (cb) => { const handler = (_e, id, toolInfo) => cb(id, toolInfo); ipcRenderer.on('agent:stream-tool-use', handler); return () => ipcRenderer.removeListener('agent:stream-tool-use', handler); },

  // Permission denial events (after-the-fact)
  onPermissionDenied: (cb) => { const handler = (_e, id, denials) => cb(id, denials); ipcRenderer.on('agent:permission-denied', handler); return () => ipcRenderer.removeListener('agent:permission-denied', handler); },

  // Real-time permission request events (interactive approval)
  onPermissionRequest: (cb) => { const handler = (_e, id, request) => cb(id, request); ipcRenderer.on('agent:permission-request', handler); return () => ipcRenderer.removeListener('agent:permission-request', handler); },
  sendPermissionResponse: (requestId, toolUseId, decision) => ipcRenderer.send('agent:permission-response', requestId, toolUseId, decision),

  // Remove all stream listeners (legacy, used by App-level cleanup)
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('agent:stream-chunk');
    ipcRenderer.removeAllListeners('agent:stream-thinking');
    ipcRenderer.removeAllListeners('agent:stream-done');
    ipcRenderer.removeAllListeners('agent:stream-error');
    ipcRenderer.removeAllListeners('agent:stream-tool-use');
    ipcRenderer.removeAllListeners('agent:permission-denied');
    ipcRenderer.removeAllListeners('agent:permission-request');
  },

  // Ping agent
  ping: (agent) => ipcRenderer.invoke('agent:ping', agent),
  listModels: (agent) => ipcRenderer.invoke('agent:list-models', agent),

  // Slash commands
  getSlashCommands: (provider) => ipcRenderer.invoke('agent:slash-commands', provider),
  discoverSlashCommands: (agent) => ipcRenderer.invoke('agent:discover-slash-commands', agent),
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

  // Terminal
  terminalInit: (agent) => ipcRenderer.invoke('terminal:init', agent),
  terminalExec: (requestId, agent, command) => ipcRenderer.send('terminal:exec', requestId, agent, command),
  terminalStdin: (agentId, data) => ipcRenderer.send('terminal:stdin', agentId, data),
  terminalKill: (agentId) => ipcRenderer.invoke('terminal:kill', agentId),
  terminalComplete: (agent, inputText) => ipcRenderer.invoke('terminal:complete', agent, inputText),
  onTerminalOutput: (cb) => { const h = (_e, id, text) => cb(id, text); ipcRenderer.on('terminal:output', h); return () => ipcRenderer.removeListener('terminal:output', h); },
  onTerminalCwd: (cb) => { const h = (_e, id, cwd) => cb(id, cwd); ipcRenderer.on('terminal:cwd', h); return () => ipcRenderer.removeListener('terminal:cwd', h); },
  onTerminalDone: (cb) => { const h = (_e, id, meta) => cb(id, meta); ipcRenderer.on('terminal:done', h); return () => ipcRenderer.removeListener('terminal:done', h); },
  onTerminalError: (cb) => { const h = (_e, id, err) => cb(id, err); ipcRenderer.on('terminal:error', h); return () => ipcRenderer.removeListener('terminal:error', h); },
  removeTerminalListeners: () => {
    ipcRenderer.removeAllListeners('terminal:output');
    ipcRenderer.removeAllListeners('terminal:cwd');
    ipcRenderer.removeAllListeners('terminal:done');
    ipcRenderer.removeAllListeners('terminal:error');
  },

  // Theme
  getSystemTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (cb) => ipcRenderer.on('theme:changed', (_e, isDark) => cb(isDark)),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
