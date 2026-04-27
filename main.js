const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const { setMainWindow, activeClaudeProcs } = require('./lib/state');
const { makeRequest } = require('./lib/http');
const { getLoginEnv } = require('./lib/local');
const { runSSHCommand } = require('./lib/ssh');
const desktopApp = require('./lib/desktop-app-pin');

// Providers
const { chatOpenClaw, streamOpenClaw, pingOpenClaw, chatOpenClawLocal, pingOpenClawLocal } = require('./providers/openclaw-improved');
const { chatHermes, streamHermes, pingHermes, chatHermesLocal, streamHermesLocal, pingHermesLocal } = require('./providers/hermes');
const { chatClaudeCode, streamClaudeCode, pingClaudeCode, chatClaudeCodeSSH, streamClaudeCodeSSH, pingClaudeCodeSSH, resolveToolApproval } = require('./providers/claude-code');
const { chatCodexLocal, streamCodexLocal, pingCodexLocal, listCodexModelsLocal, chatCodexSSH, streamCodexSSH, pingCodexSSH, listCodexModelsSSH } = require('./providers/codex');
const { chatOpenAI, streamOpenAI } = require('./providers/openai-compat');

// Feature modules
const { registerAuthHandlers } = require('./auth');
const { registerSlashCommandHandlers } = require('./slash-commands');
const { registerUpdaterHandlers, scheduleUpdateCheck } = require('./lib/updater');

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
    // Pinned-overlay mode leaves Agent Hub un-focused most of the time. Without
    // this, Cocoa eats the first click on the sidebar just to activate the
    // window — so the user has to click twice to actually hit a button.
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  nativeTheme.themeSource = 'system';
  setMainWindow(mainWindow);
  scheduleUpdateCheck();
  attachDesktopPinListeners(mainWindow);

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

// ── Desktop-app pinning (Claude.app, Codex.app, etc.) ──
// Tracks Agent Hub's content-area bounds and continuously re-pins the active
// foreign app's window over it via macOS Accessibility APIs. Only one app is
// pinned at a time. See lib/desktop-app-pin.js. Layout constants must match
// index.html's CSS.

const SIDEBAR_WIDTH = 272;     // .sidebar width in index.html
const TITLEBAR_HEIGHT = 28;    // hiddenInset traffic-light area

let pinnedApp = null;          // currently-pinned app key, or null
let pinMoveT = null;
let pinWatchInterval = null;
let pinTickCounter = 0;
let pinFocusReactivateT = null;
const PIN_REBOUND_DEBOUNCE_MS = 16;
const PIN_WATCH_INTERVAL_MS = 250;             // tight loop keeps it sticky
const PIN_VERIFY_EVERY_N_TICKS = 16;           // ≈4s per window-count probe
const PIN_FOCUS_REACTIVATE_MS = 90;            // delay before re-raising the
                                               // foreign app after Agent Hub
                                               // gains focus
// Apps we've already brought up in this session — skip ensureRunning probes
// for these on subsequent pin requests (eliminates the cold-start delay).
const pinnedReadyApps = new Set();

function computePinRect() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const b = mainWindow.getBounds();
  // Tuck the foreign app's chrome behind Agent Hub's title bar by shifting up,
  // and over-extend height so the bottom still fills.
  const x = b.x + SIDEBAR_WIDTH;
  const y = b.y + TITLEBAR_HEIGHT - 28;
  const w = b.width - SIDEBAR_WIDTH;
  const h = b.height - TITLEBAR_HEIGHT + 28;
  return { x, y, w, h };
}

// Position + raise + un-hide in one osascript call. No activate, so Agent Hub
// keeps focus. Used on Agent Hub focus events and on every watch tick.
function snapPinNow() {
  if (!pinnedApp) return;
  const rect = computePinRect();
  if (!rect) return;
  desktopApp.snapPin(pinnedApp, rect.x, rect.y, rect.w, rect.h);
}

// Activate + position + raise. Used on initial pin so the foreign window
// actually surfaces above Agent Hub's content area.
function pinAndShowNow() {
  if (!pinnedApp) return;
  const rect = computePinRect();
  if (!rect) return;
  desktopApp.pinAndShow(pinnedApp, rect.x, rect.y, rect.w, rect.h);
}

function reboundPinDebounced() {
  if (!pinnedApp) return;
  if (pinMoveT) return;
  pinMoveT = setTimeout(() => {
    pinMoveT = null;
    snapPinNow();
  }, PIN_REBOUND_DEBOUNCE_MS);
}

function startPinWatch() {
  if (pinWatchInterval) return;
  pinTickCounter = 0;
  // Tight loop: every tick we re-snap position + raise (cheap async osascript,
  // doesn't block the main thread). Every Nth tick we async-verify the window
  // still exists and relaunch if the user externally quit the app.
  pinWatchInterval = setInterval(() => {
    if (!pinnedApp) return;
    pinTickCounter++;
    snapPinNow();
    if (pinTickCounter % PIN_VERIFY_EVERY_N_TICKS === 0) {
      const which = pinnedApp;
      desktopApp.getWindowCountAsync(which).then(n => {
        if (pinnedApp !== which) return;
        if (n === 0) {
          pinnedReadyApps.delete(which);
          desktopApp.ensureRunning(which).then(() => {
            if (pinnedApp !== which) return;
            pinnedReadyApps.add(which);
            pinAndShowNow();
          }).catch(() => {});
        }
      });
    }
  }, PIN_WATCH_INTERVAL_MS);
}

function stopPinWatch() {
  if (pinWatchInterval) {
    clearInterval(pinWatchInterval);
    pinWatchInterval = null;
  }
}

function cancelFocusReactivate() {
  if (pinFocusReactivateT) {
    clearTimeout(pinFocusReactivateT);
    pinFocusReactivateT = null;
  }
}

// When Agent Hub gains focus (user clicked sidebar, title bar, etc.), the
// pinned foreign app's window goes behind in cross-process z-order. Snap it
// back into place and, after a short delay so React can process the click,
// re-activate the foreign app so it pops back on top. Brief focus pingpong
// is the price of overlay without changing window levels.
function handleAgentHubFocus() {
  if (!pinnedApp) return;
  snapPinNow();
  cancelFocusReactivate();
  pinFocusReactivateT = setTimeout(() => {
    pinFocusReactivateT = null;
    if (!pinnedApp) return;
    pinAndShowNow();
  }, PIN_FOCUS_REACTIVATE_MS);
}

function attachDesktopPinListeners(win) {
  if (!win) return;
  win.on('move', reboundPinDebounced);
  win.on('moved', snapPinNow);
  win.on('resize', reboundPinDebounced);
  win.on('resized', snapPinNow);
  win.on('enter-full-screen', snapPinNow);
  win.on('leave-full-screen', snapPinNow);
  win.on('focus', handleAgentHubFocus);
  win.on('blur', cancelFocusReactivate);
  // Hide / minimize: stop the watch loop too — every snap tick re-asserts
  // `set visible to true`, which would instantly undo our hide otherwise.
  win.on('hide', () => {
    cancelFocusReactivate();
    if (pinnedApp) {
      stopPinWatch();
      desktopApp.setVisible(pinnedApp, false);
    }
  });
  win.on('show', () => {
    if (pinnedApp) {
      startPinWatch();
      pinAndShowNow();
    }
  });
  // Yellow traffic light + Window menu → Minimize fire 'minimize', not 'hide'.
  // Mirror Agent Hub's dock state on the foreign app so they move together.
  win.on('minimize', () => {
    cancelFocusReactivate();
    if (pinnedApp) {
      stopPinWatch();
      desktopApp.setVisible(pinnedApp, false);
    }
  });
  win.on('restore', () => {
    if (pinnedApp) {
      startPinWatch();
      pinAndShowNow();
    }
  });
  win.on('close', () => {
    // Don't quit the foreign app — user may want it standalone next time
    cancelFocusReactivate();
    if (pinnedApp) desktopApp.setVisible(pinnedApp, true);
    stopPinWatch();
  });
}

ipcMain.handle('desktop-app:status', (_e, appKey) => ({
  installed: desktopApp.isInstalled(appKey),
  axGranted: desktopApp.isAXGranted(),
  pinned: pinnedApp === appKey,
  running: desktopApp.getWindowCount(appKey) > 0,
  meta: desktopApp.getAppMeta(appKey),
}));

ipcMain.handle('desktop-app:pin', async (_e, appKey) => {
  let meta;
  try { meta = desktopApp.getAppMeta(appKey); } catch (err) { return { error: err.message, code: 'unknown-app' }; }

  if (!desktopApp.isInstalled(appKey)) {
    return {
      error: `${meta.label} is not installed. Download it from ${meta.downloadUrl}.`,
      code: 'not-installed',
      downloadUrl: meta.downloadUrl,
    };
  }
  if (!desktopApp.isAXGranted()) {
    desktopApp.requestAX();
    return {
      error: 'Accessibility permission required. Grant Agent Hub access in System Settings → Privacy & Security → Accessibility, then quit and relaunch Agent Hub.',
      code: 'no-ax-permission',
    };
  }

  // Switching pinned apps: hide the previous one first (async, doesn't block)
  const prev = pinnedApp;
  if (prev && prev !== appKey) {
    desktopApp.setVisible(prev, false);
  }

  // Set state immediately so concurrent watch ticks/focus events target the
  // right app while ensureRunning is in flight.
  pinnedApp = appKey;
  startPinWatch();

  // Fast path: we've already brought this app up in this session. Skip the
  // sync probe entirely and just snap the foreign window into place.
  if (pinnedReadyApps.has(appKey)) {
    pinAndShowNow();
    return { ok: true };
  }

  try {
    await desktopApp.ensureRunning(appKey);
  } catch (err) {
    if (pinnedApp === appKey) {
      pinnedApp = prev || null;
      if (!pinnedApp) stopPinWatch();
    }
    return { error: err.message, code: 'launch-failed' };
  }
  if (pinnedApp !== appKey) return { ok: true };  // user switched away mid-launch
  pinnedReadyApps.add(appKey);
  pinAndShowNow();
  return { ok: true };
});

ipcMain.handle('desktop-app:unpin', async (_e, appKey) => {
  // Only unpin if the caller's app matches what's currently pinned, or if no
  // app is specified (force unpin whatever's pinned).
  if (appKey && pinnedApp !== appKey) return { ok: true, noop: true };
  const which = pinnedApp;
  pinnedApp = null;
  stopPinWatch();
  cancelFocusReactivate();
  if (pinMoveT) { clearTimeout(pinMoveT); pinMoveT = null; }
  if (which) desktopApp.setVisible(which, false);
  return { ok: true };
});

ipcMain.handle('desktop-app:open-ax-settings', () => {
  desktopApp.openAccessibilitySettings();
  return { ok: true };
});

ipcMain.handle('desktop-app:quit', (_e, appKey) => {
  if (pinnedApp === appKey) {
    pinnedApp = null;
    stopPinWatch();
    cancelFocusReactivate();
  }
  pinnedReadyApps.delete(appKey);
  desktopApp.quit(appKey);
  return { ok: true };
});

app.on('before-quit', () => {
  // Restore the foreign app to a normal visible state so the user can use it
  // standalone after Agent Hub closes.
  if (pinnedApp) {
    const which = pinnedApp;
    pinnedApp = null;
    desktopApp.setVisible(which, true);
  }
  stopPinWatch();
  cancelFocusReactivate();
});

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

// ── Clipboard Image → Temp File IPC ──
// Renderer sends image bytes (Uint8Array) from a paste event; we write to
// a temp file and return the path so the renderer can inject it into the PTY.

ipcMain.handle('image:save-temp', async (_event, data, ext) => {
  try {
    const buffer = Buffer.from(data);
    const safeExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `agenthub-${Date.now()}-${rand}.${safeExt}`;
    const filePath = path.join(os.tmpdir(), filename);
    fs.writeFileSync(filePath, buffer);
    return { path: filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Agent Chat IPC ──

ipcMain.handle('agent:chat', async (_event, agent, messages) => {
  try {
    if (agent.provider === 'claude-desktop' || agent.provider === 'codex-desktop') {
      return { error: 'Embedded desktop-app threads handle their own chat. No IPC.' };
    }
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
    if (agent.provider === 'claude-desktop' || agent.provider === 'codex-desktop') {
      event.sender.send('agent:stream-error', requestId, 'Embedded desktop-app threads handle their own chat. No IPC.');
      return;
    }
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
    if (agent.provider === 'claude-desktop' || agent.provider === 'codex-desktop') {
      const appKey = agent.provider === 'claude-desktop' ? 'claude' : 'codex';
      if (!desktopApp.isInstalled(appKey)) {
        return { online: false, error: `${desktopApp.getAppMeta(appKey).label} not installed` };
      }
      return { online: true, info: desktopApp.isAXGranted() ? 'AX granted' : 'AX permission needed' };
    }
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

// ── Terminal Sessions (tmux-backed for persistence) ──
//
// Each terminal tab is a tmux client pointed at a per-agent tmux session
// (`agenthub-<id>`). The pty we spawn is just the tmux client — if Electron
// exits or SSH disconnects, the tmux server keeps the session (and any running
// command) alive. Reopening the tab re-attaches with scrollback intact.

const terminalSessions = new Map(); // agentId -> { pty, tmuxName, location, agent }

function tmuxSessionName(agentId) {
  const safe = String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `agenthub-${safe}`;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function hasLocalTmux() {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Shell snippet that attaches to (or creates) a tmux session, falling back to
// a plain login shell if tmux isn't installed on the target host. `-D` kicks
// any other client off the session so the newest tab wins.
function buildTmuxCommand(name, cwd) {
  const cwdArg = cwd ? ` -c ${shQuote(cwd)}` : '';
  const cdLine = cwd ? `cd ${shQuote(cwd)} 2>/dev/null; ` : '';
  return (
    `if command -v tmux >/dev/null 2>&1; then ` +
      `exec tmux new-session -A -D -s ${shQuote(name)}${cwdArg}; ` +
    `else ` +
      `${cdLine}exec "$SHELL" -l; ` +
    `fi`
  );
}

ipcMain.handle('terminal:spawn', async (_event, agent) => {
  // Tear down any prior pty for this agent. We do NOT kill the tmux session
  // itself — that's the whole point; it outlives the client.
  const existing = terminalSessions.get(agent.id);
  if (existing?.pty) {
    try { existing.pty.kill(); } catch {}
    terminalSessions.delete(agent.id);
  }

  const env = getLoginEnv();
  const shell = env.SHELL || '/bin/bash';
  const homeDir = env.HOME || '/';
  const tmuxName = tmuxSessionName(agent.id);
  let ptyProc;
  let location;

  if (agent.provider === 'terminal-ssh') {
    location = 'ssh';
    const remoteCmd = buildTmuxCommand(tmuxName, agent.workDir || '');
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-p', String(agent.sshPort || 22)];
    if (agent.sshKey) args.push('-i', agent.sshKey);
    args.push(`${agent.sshUser || 'root'}@${agent.sshHost}`);
    args.push('-t', remoteCmd);
    ptyProc = pty.spawn('ssh', args, {
      name: 'xterm-256color',
      cols: 80, rows: 24,
      env: { ...env, TERM: 'xterm-256color' },
    });
  } else {
    location = 'local';
    const startDir = agent.workDir ? agent.workDir.replace(/^~/, homeDir) : homeDir;
    if (hasLocalTmux()) {
      const cmd = buildTmuxCommand(tmuxName, startDir);
      ptyProc = pty.spawn('/bin/sh', ['-c', cmd], {
        name: 'xterm-256color',
        cols: 80, rows: 24,
        cwd: startDir,
        env: { ...env, TERM: 'xterm-256color' },
      });
    } else {
      // No local tmux — session won't persist across app restart.
      ptyProc = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 80, rows: 24,
        cwd: startDir,
        env: { ...env, TERM: 'xterm-256color' },
      });
    }
  }

  terminalSessions.set(agent.id, { pty: ptyProc, tmuxName, location, agent });

  // Guard against events from a superseded pty leaking into the current tab.
  ptyProc.onData(data => {
    const current = terminalSessions.get(agent.id);
    if (current?.pty !== ptyProc) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', agent.id, data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    const current = terminalSessions.get(agent.id);
    if (current?.pty !== ptyProc) return;
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

// Detach: kill only the pty client, leave the tmux session running so
// claude/codex/shell processes inside survive until we reattach next launch.
ipcMain.handle('terminal:detach', async (_event, agentId) => {
  const session = terminalSessions.get(agentId);
  if (!session?.pty) return { detached: false };
  try { session.pty.kill(); } catch {}
  terminalSessions.delete(agentId);
  return { detached: true };
});

// Destroy the tmux session AND the pty client. This is "really kill it",
// used when the user removes the agent or explicitly nukes the session.
ipcMain.handle('terminal:kill', async (_event, agentId) => {
  const session = terminalSessions.get(agentId);
  if (!session?.pty) return { killed: false };

  const { pty: ptyProc, tmuxName, location, agent } = session;

  try {
    if (location === 'local') {
      if (hasLocalTmux()) {
        spawnSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' });
      }
    } else if (location === 'ssh' && agent) {
      const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5', '-p', String(agent.sshPort || 22)];
      if (agent.sshKey) args.push('-i', agent.sshKey);
      args.push(`${agent.sshUser || 'root'}@${agent.sshHost}`);
      args.push(`tmux kill-session -t ${shQuote(tmuxName)} 2>/dev/null || true`);
      spawnSync('ssh', args, { stdio: 'ignore', timeout: 7000 });
    }
  } catch {}

  try { ptyProc.kill(); } catch {}
  terminalSessions.delete(agentId);
  return { killed: true };
});

// ── Register feature handlers ──

registerAuthHandlers(ipcMain);
registerSlashCommandHandlers(ipcMain);
registerUpdaterHandlers();
