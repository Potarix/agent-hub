const { spawn, spawnSync } = require('child_process');
const { systemPreferences } = require('electron');
const fs = require('fs');

const CLAUDE_APP_PATH = '/Applications/Claude.app';
const CLAUDE_PROCESS_NAME = 'Claude';

function isClaudeInstalled() {
  return fs.existsSync(CLAUDE_APP_PATH);
}

function isAXGranted() {
  if (process.platform !== 'darwin') return false;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

function requestAX() {
  if (process.platform !== 'darwin') return false;
  return systemPreferences.isTrustedAccessibilityClient(true);
}

function runOsascript(script, timeoutMs = 1500) {
  const r = spawnSync('osascript', ['-e', script], { timeout: timeoutMs });
  return {
    stdout: (r.stdout || '').toString().trim(),
    stderr: (r.stderr || '').toString().trim(),
    status: r.status,
  };
}

function runOsascriptAsync(script) {
  const proc = spawn('osascript', ['-e', script], { detached: false });
  proc.on('error', () => {});
  if (proc.stderr) proc.stderr.on('data', () => {});
  return proc;
}

function getClaudeWindowCount() {
  const r = runOsascript(
    `tell application "System Events" to count windows of process "${CLAUDE_PROCESS_NAME}"`
  );
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : 0;
}

function getClaudePid() {
  const r = runOsascript(
    `tell application "System Events" to unix id of process "${CLAUDE_PROCESS_NAME}"`
  );
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : null;
}

async function ensureClaudeRunning(timeoutMs = 15000) {
  if (!isClaudeInstalled()) {
    throw new Error('Claude.app is not installed at /Applications/Claude.app');
  }

  // `open -g` activates without bringing to front
  spawnSync('open', ['-g', '-a', CLAUDE_APP_PATH]);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getClaudeWindowCount() > 0) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Claude.app did not produce a window within timeout');
}

// Position + size the front window of Claude.app (async — fire and forget for
// smooth tracking during drag/resize).
function setClaudeBounds(x, y, w, h) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  const wi = Math.max(200, Math.round(w));
  const hi = Math.max(200, Math.round(h));
  const script = `
    tell application "System Events"
      tell process "${CLAUDE_PROCESS_NAME}"
        try
          tell front window
            set position to {${xi}, ${yi}}
            set size to {${wi}, ${hi}}
          end tell
        end try
      end tell
    end tell
  `;
  runOsascriptAsync(script);
}

function setClaudeVisible(visible) {
  if (visible) {
    // Activating brings Claude.app frontmost. Caller should activate Agent Hub
    // back if they want focus to stay there.
    runOsascriptAsync(`tell application "${CLAUDE_PROCESS_NAME}" to activate`);
  } else {
    // `set visible to false` hides without quitting (System Events analog of
    // Cmd-H).
    runOsascriptAsync(
      `tell application "System Events" to set visible of process "${CLAUDE_PROCESS_NAME}" to false`
    );
  }
}

function raiseClaudeWindow() {
  // Bring Claude.app's window to the top of the window stack without stealing
  // app focus from Agent Hub. AXRaise on the front window is the right call.
  runOsascriptAsync(`
    tell application "System Events"
      tell process "${CLAUDE_PROCESS_NAME}"
        try
          perform action "AXRaise" of front window
        end try
      end tell
    end tell
  `);
}

function quitClaude() {
  runOsascriptAsync(`tell application "${CLAUDE_PROCESS_NAME}" to quit`);
}

function openAccessibilitySettings() {
  spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], {
    detached: true,
  }).unref();
}

module.exports = {
  CLAUDE_APP_PATH,
  isClaudeInstalled,
  isAXGranted,
  requestAX,
  ensureClaudeRunning,
  getClaudePid,
  getClaudeWindowCount,
  setClaudeBounds,
  setClaudeVisible,
  raiseClaudeWindow,
  quitClaude,
  openAccessibilitySettings,
};
