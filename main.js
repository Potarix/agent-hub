const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');

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

const terminalSessions = new Map(); // agentId -> { cwd, activeProc }
const CWD_MARKER = '___AGHUB_CWD___';

function termShellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

ipcMain.handle('terminal:init', async (_event, agent) => {
  try {
    if (agent.provider === 'terminal-ssh') {
      const startDir = agent.workDir || '~';
      const raw = await runSSHCommand(agent, `cd ${startDir} 2>/dev/null && pwd || echo $HOME`, 10000);
      const cwd = raw.trim().split('\n').pop().trim();
      terminalSessions.set(agent.id, { cwd });
      return { cwd };
    } else {
      const homeDir = process.env.HOME || '/';
      let startDir = agent.workDir ? agent.workDir.replace(/^~/, homeDir) : homeDir;
      try {
        startDir = execSync(`cd ${termShellQuote(startDir)} 2>/dev/null && pwd || echo ${termShellQuote(homeDir)}`, { encoding: 'utf-8' }).trim();
      } catch { startDir = homeDir; }
      terminalSessions.set(agent.id, { cwd: startDir });
      return { cwd: startDir };
    }
  } catch (err) {
    const fallback = process.env.HOME || '/';
    terminalSessions.set(agent.id, { cwd: fallback });
    return { cwd: fallback, error: err.message };
  }
});

function execTerminalLocal(event, requestId, agent, command, session) {
  const escapedCwd = termShellQuote(session.cwd);
  const fullCmd = `cd ${escapedCwd} 2>/dev/null; ${command}; __ahrc=$?; echo ""; echo "${CWD_MARKER}"; pwd; exit $__ahrc`;

  const proc = spawn('bash', ['-l', '-c', fullCmd], {
    env: getLoginEnv(),
  });

  session.activeProc = proc;
  let fullStdout = '';

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullStdout += text;
    event.sender.send('terminal:output', requestId, text);
  });

  proc.stderr.on('data', (chunk) => {
    event.sender.send('terminal:output', requestId, chunk.toString());
  });

  proc.on('close', (code) => {
    const markerIdx = fullStdout.indexOf(CWD_MARKER);
    let newCwd = session.cwd;
    if (markerIdx !== -1) {
      const afterMarker = fullStdout.substring(markerIdx + CWD_MARKER.length);
      const cwdLine = afterMarker.trim().split('\n')[0].trim();
      if (cwdLine) newCwd = cwdLine;
    }
    session.cwd = newCwd;
    session.activeProc = null;
    terminalSessions.set(agent.id, session);
    event.sender.send('terminal:done', requestId, { exitCode: code, cwd: newCwd });
  });

  proc.on('error', (err) => {
    session.activeProc = null;
    event.sender.send('terminal:error', requestId, err.message);
  });
}

function execTerminalSSH(event, requestId, agent, command, session) {
  const sshUser = agent.sshUser || 'root';
  const sshHost = agent.sshHost;
  const sshPort = agent.sshPort || 22;
  const sshKey = agent.sshKey || '';

  const escapedCwd = termShellQuote(session.cwd);
  const innerCmd = `cd ${escapedCwd} 2>/dev/null; ${command}; __ahrc=$?; echo ""; echo "${CWD_MARKER}"; pwd; exit $__ahrc`;

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-p', String(sshPort),
  ];
  if (sshKey) args.push('-i', sshKey);
  args.push(`${sshUser}@${sshHost}`, `bash -l -c ${JSON.stringify(innerCmd)}`);

  const proc = spawn('ssh', args);
  session.activeProc = proc;
  let fullStdout = '';

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullStdout += text;
    event.sender.send('terminal:output', requestId, text);
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('Warning:') && !text.includes('Permanently added')) {
      event.sender.send('terminal:output', requestId, text);
    }
  });

  proc.on('close', (code) => {
    const markerIdx = fullStdout.indexOf(CWD_MARKER);
    let newCwd = session.cwd;
    if (markerIdx !== -1) {
      const afterMarker = fullStdout.substring(markerIdx + CWD_MARKER.length);
      const cwdLine = afterMarker.trim().split('\n')[0].trim();
      if (cwdLine) newCwd = cwdLine;
    }
    session.cwd = newCwd;
    session.activeProc = null;
    terminalSessions.set(agent.id, session);

    if (code === 255 && !fullStdout.trim()) {
      event.sender.send('terminal:error', requestId, 'SSH connection failed');
    } else {
      event.sender.send('terminal:done', requestId, { exitCode: code, cwd: newCwd });
    }
  });

  proc.on('error', (err) => {
    session.activeProc = null;
    event.sender.send('terminal:error', requestId, err.message);
  });
}

ipcMain.on('terminal:exec', async (event, requestId, agent, command) => {
  const session = terminalSessions.get(agent.id) || { cwd: process.env.HOME || '/' };
  if (!terminalSessions.has(agent.id)) terminalSessions.set(agent.id, session);

  try {
    if (agent.provider === 'terminal-ssh') {
      execTerminalSSH(event, requestId, agent, command, session);
    } else {
      execTerminalLocal(event, requestId, agent, command, session);
    }
  } catch (err) {
    event.sender.send('terminal:error', requestId, err.message);
  }
});

ipcMain.handle('terminal:kill', async (_event, agentId) => {
  const session = terminalSessions.get(agentId);
  if (session?.activeProc) {
    session.activeProc.kill('SIGINT');
    return { killed: true };
  }
  return { killed: false };
});

// ── Register feature handlers ──

registerAuthHandlers(ipcMain);
registerSlashCommandHandlers(ipcMain);
