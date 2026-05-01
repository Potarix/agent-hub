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

  // Terminal (real PTY via xterm.js)
  terminalSpawn: (agent) => ipcRenderer.invoke('terminal:spawn', agent),
  terminalInput: (agentId, data) => ipcRenderer.send('terminal:input', agentId, data),
  terminalResize: (agentId, cols, rows) => ipcRenderer.send('terminal:resize', agentId, cols, rows),
  terminalKill: (agentId) => ipcRenderer.invoke('terminal:kill', agentId),
  terminalDetach: (agentId) => ipcRenderer.invoke('terminal:detach', agentId),
  onTerminalData: (cb) => { const h = (_e, id, data) => cb(id, data); ipcRenderer.on('terminal:data', h); return () => ipcRenderer.removeListener('terminal:data', h); },
  onTerminalExit: (cb) => { const h = (_e, id, code) => cb(id, code); ipcRenderer.on('terminal:exit', h); return () => ipcRenderer.removeListener('terminal:exit', h); },
  removeTerminalListeners: () => {
    ipcRenderer.removeAllListeners('terminal:data');
    ipcRenderer.removeAllListeners('terminal:exit');
  },

  // Theme
  getSystemTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (cb) => ipcRenderer.on('theme:changed', (_e, isDark) => cb(isDark)),

  // App/update status
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Find bar — main process menu (Cmd+F / Cmd+G / Shift+Cmd+G / Cmd+Alt+F)
  // posts {action: 'open'|'next'|'prev'|'useSelection'|'close'} and the
  // renderer routes to the active view's find engine.
  onFindCommand: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('find:command', handler);
    return () => ipcRenderer.removeListener('find:command', handler);
  },

  // Save clipboard image to temp file, returns { path } or { error }
  saveImageTemp: (data, ext) => ipcRenderer.invoke('image:save-temp', data, ext),

  // Native clipboard. Routed through main because the preload is sandboxed
  // (Electron 20+ default), so require('electron').clipboard is undefined
  // here. Both methods are async.
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write', text),
    readText: () => ipcRenderer.invoke('clipboard:read'),
  },

  // Copy/Paste routing for Edit-menu clicks. The renderer chooses
  // xterm-specific behavior or falls back to native DOM copy/paste.
  onClipboardShortcut: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('clipboard:shortcut', handler);
    return () => ipcRenderer.removeListener('clipboard:shortcut', handler);
  },
  // Renderer asks main to perform a native copy/paste on the focused
  // element. Used as the fallback when focus is NOT in an xterm.
  nativeClipboard: (action) => ipcRenderer.send('native-clipboard', action),

  // Desktop-app window-pinning — pins a foreign macOS app (Claude.app,
  // Codex.app) visually inside Agent Hub's content area via Accessibility APIs.
  // appKey is one of 'claude', 'codex' (see lib/desktop-app-pin.js).
  desktopApp: {
    status: (appKey) => ipcRenderer.invoke('desktop-app:status', appKey),
    pin: (appKey) => ipcRenderer.invoke('desktop-app:pin', appKey),
    unpin: (appKey) => ipcRenderer.invoke('desktop-app:unpin', appKey),
    openAxSettings: () => ipcRenderer.invoke('desktop-app:open-ax-settings'),
    quit: (appKey) => ipcRenderer.invoke('desktop-app:quit', appKey),
    // Fires with 'claude' or 'codex' when the user clicks into the pinned
    // foreign app — used to bubble the matching agent up the sidebar.
    onUserActive: (cb) => {
      const handler = (_e, appKey) => cb(appKey);
      ipcRenderer.on('desktop-app:user-active', handler);
      return () => ipcRenderer.removeListener('desktop-app:user-active', handler);
    },
  },
});
