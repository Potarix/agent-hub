const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');

const { setMainWindow, activeClaudeProcs } = require('./lib/state');
const { makeRequest } = require('./lib/http');

// Providers
const { chatOpenClaw, streamOpenClaw, pingOpenClaw, chatOpenClawLocal, pingOpenClawLocal } = require('./providers/openclaw-improved');
const { chatHermes, pingHermes, chatHermesLocal, pingHermesLocal } = require('./providers/hermes');
const { chatClaudeCode, streamClaudeCode, pingClaudeCode, chatClaudeCodeSSH, streamClaudeCodeSSH, pingClaudeCodeSSH, getClaudeSDK } = require('./providers/claude-code');
const { chatCodexLocal, streamCodexLocal, pingCodexLocal, chatCodexSSH, streamCodexSSH, pingCodexSSH } = require('./providers/codex');
const { chatOpenAI, streamOpenAI } = require('./providers/openai-compat');

// Pre-initialize Claude Code SDK on app startup with retries
// This runs asynchronously and doesn't block the app startup
async function ensureClaudeSDKReady() {
  const maxRetries = 5;
  let retryDelay = 1000;

  for (let i = 1; i <= maxRetries; i++) {
    try {
      await getClaudeSDK();
      console.log(`[Main] Claude Code SDK pre-warmed successfully (attempt ${i})`);
      return true;
    } catch (err) {
      console.warn(`[Main] Claude Code SDK pre-warm attempt ${i}/${maxRetries} failed:`, err.message);
      if (i < maxRetries) {
        console.log(`[Main] Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 1.5, 5000); // Exponential backoff up to 5 seconds
      }
    }
  }
  console.error('[Main] Claude Code SDK failed to initialize after all attempts');
  return false;
}

// Start SDK initialization immediately and keep retrying
ensureClaudeSDKReady();

// Feature modules
const { registerAuthHandlers } = require('./auth');
const { registerSlashCommandHandlers } = require('./slash-commands');

// ── Electron App ──

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0f' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  nativeTheme.themeSource = 'system';
  setMainWindow(mainWindow);

  const updateBgColor = () => {
    const isDark = nativeTheme.shouldUseDarkColors;
    mainWindow.setBackgroundColor(isDark ? '#0a0a0f' : '#f5f5f7');
  };
  updateBgColor();

  nativeTheme.on('updated', () => {
    updateBgColor();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
    }
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Theme IPC ──

ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors);

// ── External Links IPC ──

ipcMain.handle('open-external', async (_event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Agent Chat IPC ──

ipcMain.handle('agent:chat', async (_event, agent, messages) => {
  try {
    if (agent.provider === 'openclaw') return await chatOpenClaw(agent, messages);
    if (agent.provider === 'openclaw-local') return await chatOpenClawLocal(agent, messages);
    if (agent.provider === 'hermes') return await chatHermes(agent, messages);
    if (agent.provider === 'hermes-local') return await chatHermesLocal(agent, messages);
    if (agent.provider === 'claude-code') return await chatClaudeCode(agent, messages);
    if (agent.provider === 'claude-code-ssh') return await chatClaudeCodeSSH(agent, messages);
    if (agent.provider === 'codex') return await chatCodexLocal(agent, messages);
    if (agent.provider === 'codex-ssh') return await chatCodexSSH(agent, messages);
    return await chatOpenAI(agent, messages);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('agent:chat-stream', async (event, requestId, agent, messages) => {
  try {
    if (agent.provider === 'claude-code') await streamClaudeCode(event, requestId, agent, messages);
    else if (agent.provider === 'claude-code-ssh') await streamClaudeCodeSSH(event, requestId, agent, messages);
    else if (agent.provider === 'codex') await streamCodexLocal(event, requestId, agent, messages);
    else if (agent.provider === 'codex-ssh') await streamCodexSSH(event, requestId, agent, messages);
    else if (agent.provider === 'openclaw') await streamOpenClaw(event, requestId, agent, messages);
    else if (agent.provider === 'openclaw-local') await streamOpenClaw(event, requestId, agent, messages);
    else if (agent.provider === 'hermes' || agent.provider === 'hermes-local') {
      const chatFn = agent.provider === 'hermes' ? chatHermes : chatHermesLocal;
      const res = await chatFn(agent, messages);
      if (res.error) {
        event.sender.send('agent:stream-error', requestId, res.error);
      } else {
        if (res.thinking) event.sender.send('agent:stream-thinking', requestId, res.thinking);
        if (res.content) event.sender.send('agent:stream-chunk', requestId, res.content);
        event.sender.send('agent:stream-done', requestId, { sessionId: res.sessionId || null });
      }
    }
    else await streamOpenAI(event, requestId, agent, messages);
  } catch (err) {
    event.sender.send('agent:stream-error', requestId, err.message);
  }
});

// ── Permission Responses ──

ipcMain.on('agent:permission-response', (_event, requestId, toolUseId, decision) => {
  const handle = activeClaudeProcs.get(requestId);
  if (!handle) return;

  if (handle.resolvePermission) {
    handle.resolvePermission(toolUseId, decision);
    return;
  }

  if (handle.stdin && !handle.killed) {
    try {
      const response = JSON.stringify({
        type: 'tool_permission_response',
        tool_use_id: toolUseId,
        decision,
      });
      handle.stdin.write(response + '\n');
    } catch { /* process may have exited */ }
  }
});

// ── Agent Ping IPC ──

ipcMain.handle('agent:ping', async (_event, agent) => {
  try {
    if (agent.provider === 'openclaw') return await pingOpenClaw(agent);
    if (agent.provider === 'hermes') return await pingHermes(agent);
    if (agent.provider === 'openclaw-local') return await pingOpenClawLocal();
    if (agent.provider === 'hermes-local') return await pingHermesLocal();
    if (agent.provider === 'claude-code') return await pingClaudeCode(agent);
    if (agent.provider === 'claude-code-ssh') return await pingClaudeCodeSSH(agent);
    if (agent.provider === 'codex') return await pingCodexLocal(agent);
    if (agent.provider === 'codex-ssh') return await pingCodexSSH(agent);
    // OpenAI-compat fallback
    const url = `${agent.baseUrl}/v1/models`;
    const res = await makeRequest(url, {
      method: 'GET',
      headers: agent.apiKey ? { 'Authorization': `Bearer ${agent.apiKey}` } : {},
    });
    return { online: res.status === 200 };
  } catch (err) {
    return { online: false, error: err.message };
  }
});

// ── Register feature handlers ──

registerAuthHandlers(ipcMain);
registerSlashCommandHandlers(ipcMain);
