const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const pty = require('node-pty');

const { setMainWindow, activeClaudeProcs } = require('./lib/state');
const { makeRequest } = require('./lib/http');
const { getLoginEnv } = require('./lib/local');
const { runSSHCommand } = require('./lib/ssh');

// Providers
const { chatOpenClaw, streamOpenClaw, pingOpenClaw, chatOpenClawLocal, pingOpenClawLocal } = require('./providers/openclaw-improved');
const { chatHermes, streamHermes, pingHermes, chatHermesLocal, streamHermesLocal, pingHermesLocal } = require('./providers/hermes');
const { chatClaudeCode, streamClaudeCode, pingClaudeCode, chatClaudeCodeSSH, streamClaudeCodeSSH, pingClaudeCodeSSH, resolveToolApproval } = require('./providers/claude-code');
const { chatCodexLocal, streamCodexLocal, pingCodexLocal, listCodexModelsLocal, chatCodexSSH, streamCodexSSH, pingCodexSSH, listCodexModelsSSH } = require('./providers/codex');
const { chatOpenAI, streamOpenAI } = require('./providers/openai-compat');

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
    else if (agent.provider === 'hermes') await streamHermes(event, requestId, agent, messages);
    else if (agent.provider === 'hermes-local') await streamHermesLocal(event, requestId, agent, messages);
    else await streamOpenAI(event, requestId, agent, messages);
  } catch (err) {
    event.sender.send('agent:stream-error', requestId, err.message);
  }
});

// ── Permission Responses ──

ipcMain.on('agent:permission-response', (_event, requestId, toolUseId, decision) => {
  const handle = activeClaudeProcs.get(requestId);
  if (!handle) return;

  // SDK-based sessions use Promise callbacks
  if (handle.sdkSession && handle.resolveToolApproval) {
    resolveToolApproval(toolUseId, decision);
    return;
  }

  // CLI-based sessions write to stdin
  if (!handle.stdin) return;
  try {
    const allow = decision.behavior === 'allow';
    const response = JSON.stringify({
      type: 'control_response',
      request_id: toolUseId,
      allow,
      ...(!allow && decision.message ? { reason: decision.message } : {}),
    });
    handle.stdin.write(response + '\n');
  } catch { /* process may have exited */ }
});

// ── Agent Ping IPC ──

ipcMain.handle('agent:ping', async (_event, agent) => {
  try {
    if (agent.provider === 'terminal') return { online: true };
    if (agent.provider === 'terminal-ssh') {
      try {
        await runSSHCommand(agent, 'echo ok', 10000);
        return { online: true };
      } catch (err) {
        return { online: false, error: err.message };
      }
    }
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

ipcMain.handle('agent:list-models', async (_event, agent) => {
  try {
    if (agent.provider === 'codex') return await listCodexModelsLocal(agent);
    if (agent.provider === 'codex-ssh') return await listCodexModelsSSH(agent);
    return { models: [], defaultModel: '', source: 'none' };
  } catch (err) {
    return { models: [], defaultModel: '', source: 'error', error: err.message };
  }
});

// ── Terminal Sessions ──

const terminalSessions = new Map(); // agentId -> { pty }

ipcMain.handle('terminal:spawn', async (_event, agent) => {
  // Kill any existing session
  const existing = terminalSessions.get(agent.id);
  if (existing?.pty) {
    try { existing.pty.kill(); } catch {}
    terminalSessions.delete(agent.id);
  }

  const env = getLoginEnv();
  const shell = env.SHELL || '/bin/bash';
  const homeDir = env.HOME || '/';
  let ptyProc;

  if (agent.provider === 'terminal-ssh') {
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-p', String(agent.sshPort || 22)];
    if (agent.sshKey) args.push('-i', agent.sshKey);
    args.push(`${agent.sshUser || 'root'}@${agent.sshHost}`);
    if (agent.workDir) {
      // Jump into the working directory on connect
      args.push('-t', `cd ${agent.workDir} 2>/dev/null; exec $SHELL -l`);
    }
    ptyProc = pty.spawn('ssh', args, {
      name: 'xterm-256color',
      cols: 80, rows: 24,
      env: { ...env, TERM: 'xterm-256color' },
    });
  } else {
    const startDir = agent.workDir ? agent.workDir.replace(/^~/, homeDir) : homeDir;
    ptyProc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80, rows: 24,
      cwd: startDir,
      env: { ...env, TERM: 'xterm-256color' },
    });
  }

  terminalSessions.set(agent.id, { pty: ptyProc });

  ptyProc.onData(data => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', agent.id, data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', agent.id, exitCode);
    }
    terminalSessions.delete(agent.id);
  });

  return { pid: ptyProc.pid };
});

// Write keystrokes to PTY
ipcMain.on('terminal:input', (_event, agentId, data) => {
  const session = terminalSessions.get(agentId);
  if (session?.pty) {
    try { session.pty.write(data); } catch {}
  }
});

// Resize PTY
ipcMain.on('terminal:resize', (_event, agentId, cols, rows) => {
  const session = terminalSessions.get(agentId);
  if (session?.pty) {
    try { session.pty.resize(Math.max(cols, 2), Math.max(rows, 2)); } catch {}
  }
});

// Kill PTY
ipcMain.handle('terminal:kill', async (_event, agentId) => {
  const session = terminalSessions.get(agentId);
  if (session?.pty) {
    try { session.pty.kill(); } catch {}
    terminalSessions.delete(agentId);
    return { killed: true };
  }
  return { killed: false };
});

// ── Register feature handlers ──

registerAuthHandlers(ipcMain);
registerSlashCommandHandlers(ipcMain);
