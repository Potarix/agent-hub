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
});
