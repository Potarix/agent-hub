const { spawn, spawnSync } = require('child_process');
const { systemPreferences } = require('electron');
const fs = require('fs');

// Registry of desktop apps that can be pinned inside Agent Hub's content area.
// Add new entries here to support more apps.
const APPS = {
  claude: {
    appName: 'Claude',           // CFBundleName, used by `tell application "..."`
    processName: 'Claude',       // System Events process name (usually = CFBundleName)
    path: '/Applications/Claude.app',
    label: 'Claude Desktop',
    downloadUrl: 'https://claude.ai/download',
  },
  codex: {
    appName: 'Codex',
    processName: 'Codex',
    path: '/Applications/Codex.app',
    label: 'Codex Desktop',
    downloadUrl: 'https://chatgpt.com/codex',
  },
};

function getApp(key) {
  const app = APPS[key];
  if (!app) throw new Error(`Unknown desktop app: ${key}`);
  return app;
}

function isInstalled(key) {
  return fs.existsSync(getApp(key).path);
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

// Async osascript that resolves with stdout. Use this on the hot path so the
// main thread never blocks on a sync spawn (osascript startup is ~80–200ms).
function runOsascriptPromise(script, timeoutMs = 1500) {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = (val) => { if (done) return; done = true; resolve(val); };
    const proc = spawn('osascript', ['-e', script]);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => finish(out.trim()));
    proc.on('error', () => finish(''));
    const t = setTimeout(() => { try { proc.kill(); } catch {} finish(''); }, timeoutMs);
    proc.on('close', () => clearTimeout(t));
  });
}

function getWindowCount(key) {
  const { processName } = getApp(key);
  const r = runOsascript(
    `tell application "System Events" to count windows of process "${processName}"`
  );
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : 0;
}

async function getWindowCountAsync(key) {
  const { processName } = getApp(key);
  const out = await runOsascriptPromise(
    `tell application "System Events" to count windows of process "${processName}"`
  );
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

function getPid(key) {
  const { processName } = getApp(key);
  const r = runOsascript(
    `tell application "System Events" to unix id of process "${processName}"`
  );
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : null;
}

async function ensureRunning(key, timeoutMs = 15000) {
  const app = getApp(key);
  if (!isInstalled(key)) {
    throw new Error(`${app.label} is not installed at ${app.path}`);
  }

  // Fast path: app is already up with a window — no relaunch needed.
  if (await getWindowCountAsync(key) > 0) return true;

  // Background-launch (no focus steal). Async spawn so main thread keeps moving.
  spawn('open', ['-g', '-a', app.path], { detached: true }).unref();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await getWindowCountAsync(key) > 0) return true;
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`${app.label} did not produce a window within timeout`);
}

function setBounds(key, x, y, w, h) {
  const { processName } = getApp(key);
  const xi = Math.round(x);
  const yi = Math.round(y);
  const wi = Math.max(200, Math.round(w));
  const hi = Math.max(200, Math.round(h));
  const script = `
    tell application "System Events"
      tell process "${processName}"
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

// One-shot: activate + un-hide + position + raise. Used on initial pin so the
// foreign window appears in place in a single osascript invocation.
function pinAndShow(key, x, y, w, h) {
  const { appName, processName } = getApp(key);
  const xi = Math.round(x);
  const yi = Math.round(y);
  const wi = Math.max(200, Math.round(w));
  const hi = Math.max(200, Math.round(h));
  const script = `
    tell application "${appName}" to activate
    tell application "System Events"
      try
        set visible of process "${processName}" to true
      end try
      tell process "${processName}"
        try
          tell front window
            set position to {${xi}, ${yi}}
            set size to {${wi}, ${hi}}
            perform action "AXRaise"
          end tell
        end try
      end tell
    end tell
  `;
  runOsascriptAsync(script);
}

// Periodic snap: position + raise + un-hide WITHOUT activate (no focus theft).
// Cheap enough to run on a tight watch interval.
function snapPin(key, x, y, w, h) {
  const { processName } = getApp(key);
  const xi = Math.round(x);
  const yi = Math.round(y);
  const wi = Math.max(200, Math.round(w));
  const hi = Math.max(200, Math.round(h));
  const script = `
    tell application "System Events"
      try
        set visible of process "${processName}" to true
      end try
      tell process "${processName}"
        try
          tell front window
            set position to {${xi}, ${yi}}
            set size to {${wi}, ${hi}}
            perform action "AXRaise"
          end tell
        end try
      end tell
    end tell
  `;
  runOsascriptAsync(script);
}

function setVisible(key, visible) {
  const { appName, processName } = getApp(key);
  if (visible) {
    runOsascriptAsync(`tell application "${appName}" to activate`);
  } else {
    runOsascriptAsync(
      `tell application "System Events" to set visible of process "${processName}" to false`
    );
  }
}

function raiseWindow(key) {
  const { processName } = getApp(key);
  runOsascriptAsync(`
    tell application "System Events"
      tell process "${processName}"
        try
          perform action "AXRaise" of front window
        end try
      end tell
    end tell
  `);
}

function quit(key) {
  const { appName } = getApp(key);
  runOsascriptAsync(`tell application "${appName}" to quit`);
}

function openAccessibilitySettings() {
  spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], {
    detached: true,
  }).unref();
}

function getAppMeta(key) {
  return { ...getApp(key) };
}

function listApps() {
  return Object.keys(APPS);
}

module.exports = {
  APPS,
  listApps,
  getAppMeta,
  isInstalled,
  isAXGranted,
  requestAX,
  ensureRunning,
  getPid,
  getWindowCount,
  getWindowCountAsync,
  setBounds,
  pinAndShow,
  snapPin,
  setVisible,
  raiseWindow,
  quit,
  openAccessibilitySettings,
};
