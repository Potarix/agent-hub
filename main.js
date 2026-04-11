const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');

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

  // Update background color to match system theme
  const updateBgColor = () => {
    const isDark = nativeTheme.shouldUseDarkColors;
    mainWindow.setBackgroundColor(isDark ? '#0a0a0f' : '#f5f5f7');
  };
  updateBgColor();

  // Notify renderer when macOS theme changes
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

// ── HTTP helpers ──

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function makeStreamRequest(url, options, body, event, requestId) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(url, options, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              event.sender.send('agent:stream-done', requestId, {});
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) event.sender.send('agent:stream-chunk', requestId, content);
              } catch (e) { /* skip */ }
            }
          }
        }
      });
      res.on('end', () => { event.sender.send('agent:stream-done', requestId, {}); resolve(); });
    });
    req.on('error', (err) => { event.sender.send('agent:stream-error', requestId, err.message); reject(err); });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── OpenClaw via SSH ──

function runSSHCommand(agent, command, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const sshUser = agent.sshUser || 'root';
    const sshHost = agent.sshHost;
    const sshPort = agent.sshPort || 22;
    const sshKey = agent.sshKey || '';

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ConnectTimeout=10`,
      '-p', String(sshPort),
    ];
    if (sshKey) args.push('-i', sshKey);
    // Wrap in login shell so PATH includes user-installed tools (hermes, openclaw, etc.)
    const wrappedCommand = `bash -l -c ${JSON.stringify(command)}`;
    args.push(`${sshUser}@${sshHost}`, wrappedCommand);

    const proc = spawn('ssh', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('SSH command timeout'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // OpenClaw often exits with code 1 due to gateway warnings but still has valid output
      const combined = stdout + '\n' + stderr;
      if (stdout.trim() || combined.includes('payloads')) {
        resolve(combined);
      } else if (code === 0) {
        resolve(stdout);
      } else if (code === 255) {
        // SSH connection failure
        reject(new Error(`SSH connection failed: ${stderr.trim() || 'Could not connect to host'}`));
      } else {
        reject(new Error(stderr.trim() || `Command exited with code ${code}`));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function streamSSHCommand(agent, command, event, requestId, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const sshUser = agent.sshUser || 'root';
    const sshHost = agent.sshHost;
    const sshPort = agent.sshPort || 22;
    const sshKey = agent.sshKey || '';

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ConnectTimeout=10`,
      '-p', String(sshPort),
    ];
    if (sshKey) args.push('-i', sshKey);
    args.push(`${sshUser}@${sshHost}`, command);

    const proc = spawn('ssh', args);
    let fullOutput = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullOutput += text;
      event.sender.send('agent:stream-chunk', requestId, text);
    });

    proc.stderr.on('data', (chunk) => {
      // Some stderr is normal for SSH, ignore connection messages
      const text = chunk.toString();
      if (!text.includes('Warning:') && !text.includes('Permanently added')) {
        fullOutput += text;
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      event.sender.send('agent:stream-done', requestId, {});
      resolve(fullOutput);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      event.sender.send('agent:stream-done', requestId, {});
      resolve(fullOutput);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      reject(err);
    });
  });
}

function extractOpenClawResponse(output) {
  // The output has stderr warnings before JSON. Find the JSON object.
  const jsonMatch = output.match(/\{[\s\S]*"payloads"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      const texts = (data.payloads || [])
        .map(p => p.text)
        .filter(Boolean);
      if (texts.length > 0) return texts.join('\n\n');
    } catch { /* fall through */ }
  }
  // Fallback: strip known stderr prefixes and return raw text
  const lines = output.split('\n').filter(l =>
    !l.startsWith('gateway connect failed') &&
    !l.startsWith('Gateway agent failed') &&
    !l.startsWith('Gateway target:') &&
    !l.startsWith('Source:') &&
    !l.startsWith('Config:') &&
    !l.startsWith('Bind:') &&
    l.trim()
  );
  return lines.join('\n').trim() || output.trim();
}

async function chatOpenClaw(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const agentId = agent.openclawAgent || 'main';
  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');

  let cmd = `openclaw agent --agent '${agentId}' --message '${escapedMsg}' --json 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    const content = extractOpenClawResponse(output);
    return { content };
  } catch (err) {
    // The command might "fail" but still have output in stderr
    const errMsg = err.message || '';
    const content = extractOpenClawResponse(errMsg);
    if (content && !content.includes('Permission denied') && !content.includes('Connection refused')) {
      return { content };
    }
    return { error: err.message };
  }
}

async function streamOpenClaw(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message');
    return;
  }

  const agentId = agent.openclawAgent || 'main';
  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');

  // Use --json and parse at the end since openclaw doesn't stream tokens
  let cmd = `openclaw agent --agent '${agentId}' --message '${escapedMsg}' --json 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    const content = extractOpenClawResponse(output);
    // Send the full response as one chunk
    event.sender.send('agent:stream-chunk', requestId, content);
    event.sender.send('agent:stream-done', requestId, {});
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractOpenClawResponse(errMsg);
    if (content && !content.includes('Permission denied') && !content.includes('Connection refused')) {
      event.sender.send('agent:stream-chunk', requestId, content);
      event.sender.send('agent:stream-done', requestId, {});
    } else {
      event.sender.send('agent:stream-error', requestId, err.message);
    }
  }
}

async function pingOpenClaw(agent) {
  try {
    const output = await runSSHCommand(agent, 'openclaw status --json 2>/dev/null || openclaw --version', 15000);
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Provider: Hermes Agent (NousResearch) ──

function extractHermesResponse(output) {
  // Hermes outputs the response directly to stdout
  // Strip any ANSI escape codes, spinner lines, and common noise
  const cleaned = output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') // ANSI escapes
    .replace(/\r/g, '')
    .split('\n')
    .filter(l =>
      l.trim() &&
      !l.startsWith('[hermes]') &&
      !l.startsWith('[info]') &&
      !l.startsWith('[debug]') &&
      !l.startsWith('[warn]') &&
      !l.startsWith('⠋') && !l.startsWith('⠙') && !l.startsWith('⠹') &&
      !l.startsWith('⠸') && !l.startsWith('⠼') && !l.startsWith('⠴') &&
      !l.startsWith('⠦') && !l.startsWith('⠧') && !l.startsWith('⠇') && !l.startsWith('⠏') &&
      !l.includes('Thinking...') &&
      !l.includes('Loading')
    )
    .join('\n')
    .trim();
  return cleaned || output.trim();
}

async function chatHermes(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');

  // Build the hermes command
  let cmd = 'hermes chat';
  if (agent.hermesProvider) cmd += ` --provider '${agent.hermesProvider}'`;
  if (agent.model) cmd += ` --model '${agent.model}'`;
  if (agent.hermesWorktree) cmd += ` --worktree '${agent.hermesWorktree}'`;
  // -q flag for one-shot non-interactive mode
  cmd += ` -q '${escapedMsg}' 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    const content = extractHermesResponse(output);
    return { content };
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractHermesResponse(errMsg);
    if (content && content.length > 20 && !content.includes('Permission denied') && !content.includes('Connection refused')) {
      return { content };
    }
    return { error: err.message };
  }
}

async function pingHermes(agent) {
  try {
    const output = await runSSHCommand(agent, 'hermes --version 2>&1', 15000);
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Provider: Claude Code (local CLI) ──

// Track persistent Claude Code sessions (kept alive between messages)
const claudeCodeSessions = {};

// Get a full login-shell environment so spawned processes find CLI tools and auth tokens
let _loginEnv = null;
function getLoginEnv() {
  if (_loginEnv) return _loginEnv;
  try {
    const raw = execSync('/bin/bash -l -c env', { timeout: 5000, encoding: 'utf-8' });
    const env = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
    }
    _loginEnv = env;
  } catch {
    _loginEnv = process.env;
  }
  return _loginEnv;
}

function runLocalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...getLoginEnv(), ...(options.env || {}) },
      cwd: options.cwd || process.env.HOME,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = options.timeout || 300000;
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Command timeout'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Claude Code may exit with non-zero but still have valid output
      if (stdout.trim()) {
        resolve(stdout);
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function extractClaudeCodeResponse(output) {
  // Try parsing as JSON first (if --output-format json was used)
  try {
    const data = JSON.parse(output);
    if (data.result) return data.result;
    if (data.content) return data.content;
    if (data.text) return data.text;
  } catch { /* not JSON, that's fine */ }

  // Strip ANSI escape codes and spinner noise
  const cleaned = output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l =>
      l.trim() &&
      !l.startsWith('╭') && !l.startsWith('╰') && !l.startsWith('│') &&
      !l.startsWith('⠋') && !l.startsWith('⠙') && !l.startsWith('⠹') &&
      !l.startsWith('⠸') && !l.startsWith('⠼') && !l.startsWith('⠴') &&
      !l.startsWith('⠦') && !l.startsWith('⠧') && !l.startsWith('⠇') && !l.startsWith('⠏')
    )
    .join('\n')
    .trim();

  return cleaned || output.trim();
}

async function chatClaudeCode(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const claudePath = agent.claudePath || 'claude';
  const workDir = agent.workDir || process.env.HOME;
  const escapedMsg = lastUserMsg.content;

  // Always use stream-json + verbose so we can capture thinking blocks
  const args = ['-p', escapedMsg, '--output-format', 'stream-json', '--verbose'];
  if (agent.model) args.push('--model', agent.model);

  // Permission mode — default to acceptEdits so Claude can edit files without an interactive terminal.
  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permMode);
  }

  // Allowed tools — whitelist specific tools (e.g. "Bash(codex:*) Bash(npm:*)")
  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean);
    if (tools.length) args.push('--allowedTools', ...tools);
  }

  if (agent.claudeArgs) {
    args.push(...agent.claudeArgs.split(/\s+/).filter(Boolean));
  }

  // If a session ID is stored, continue it for conversation context
  if (agent.sessionId) {
    args.push('--continue', agent.sessionId);
  } else if (agent.continueSession) {
    args.push('--continue');
  }

  try {
    const output = await runLocalCommand(claudePath, args, {
      cwd: workDir,
      timeout: agent.timeout || 300000,
    });

    let content, sessionId, thinking = null;

    // Parse stream-json: multiple JSON lines — extract thinking, result, and session_id
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              thinking = (thinking || '') + block.thinking;
            }
          }
        }
        if (evt.type === 'result') {
          content = evt.result || '';
          sessionId = evt.session_id || null;
        }
      } catch { /* skip non-JSON lines */ }
    }
    if (!content) content = extractClaudeCodeResponse(output);

    if (content.includes('401') || content.includes('authentication_error') || content.includes('Failed to authenticate')) {
      return { error: 'Claude Code is not authenticated. Click Login below to sign in.' };
    }
    return { content, sessionId, thinking };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('authentication_error') || msg.includes('Failed to authenticate')) {
      return { error: 'Claude Code is not authenticated. Click Login below to sign in.' };
    }
    return { error: msg };
  }
}

async function streamClaudeCode(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const claudePath = agent.claudePath || 'claude';
  const workDir = agent.workDir || process.env.HOME;
  const args = ['-p', lastUserMsg.content, '--output-format', 'stream-json', '--verbose'];
  if (agent.model) args.push('--model', agent.model);

  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permMode);
  }

  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean);
    if (tools.length) args.push('--allowedTools', ...tools);
  }

  if (agent.claudeArgs) {
    args.push(...agent.claudeArgs.split(/\s+/).filter(Boolean));
  }
  if (agent.sessionId) {
    args.push('--continue', agent.sessionId);
  } else if (agent.continueSession) {
    args.push('--continue');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(claudePath, args, {
      env: { ...getLoginEnv() },
      cwd: workDir,
    });

    let buffer = '';
    let sessionId = null;
    const pendingToolUses = {};  // tool_use_id -> { tool, input }

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'thinking' && block.thinking) {
                event.sender.send('agent:stream-thinking', requestId, block.thinking);
              } else if (block.type === 'text' && block.text) {
                event.sender.send('agent:stream-chunk', requestId, block.text);
              } else if (block.type === 'tool_use') {
                pendingToolUses[block.id] = { tool: block.name, input: block.input };
                event.sender.send('agent:stream-tool-use', requestId, {
                  id: block.id,
                  tool: block.name,
                  input: block.input,
                });
              }
            }
          }
          if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              event.sender.send('agent:stream-chunk', requestId, evt.delta.text);
            } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              event.sender.send('agent:stream-thinking', requestId, evt.delta.thinking);
            }
          }
          if (evt.type === 'result') {
            sessionId = evt.session_id || null;
            // Emit permission denials if any tools were blocked
            const denials = evt.permission_denials || [];
            if (denials.length > 0) {
              // Enrich with tracked tool input data
              const enriched = denials.map(d => ({
                tool: d.tool_name || d.tool || 'unknown',
                input: d.tool_input || pendingToolUses[d.tool_use_id]?.input || {},
                toolUseId: d.tool_use_id,
              }));
              event.sender.send('agent:permission-denied', requestId, enriched);
            }
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on('data', () => { /* ignore stderr */ });

    const timeout = agent.timeout || 300000;
    const timer = setTimeout(() => {
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'Command timeout');
      reject(new Error('Command timeout'));
    }, timeout);

    proc.on('close', () => {
      clearTimeout(timer);
      event.sender.send('agent:stream-done', requestId, { sessionId });
      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      reject(err);
    });
  });
}

async function streamCodexLocal(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const codexPath = agent.codexPath || 'codex';
  const workDir = agent.workDir || process.env.HOME;
  const args = [lastUserMsg.content, '--experimental-json', '--full-auto', '--skip-git-repo-check'];
  if (agent.model) args.push('--model', agent.model);
  if (agent.codexArgs) {
    args.push(...agent.codexArgs.split(/\s+/).filter(Boolean));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(codexPath, args, {
      env: { ...getLoginEnv() },
      cwd: workDir,
    });

    let buffer = '';
    let stderrBuf = '';
    let sentAnyContent = false;

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'message' && evt.message?.content) {
            for (const block of (Array.isArray(evt.message.content) ? evt.message.content : [])) {
              if (block.type === 'output_text' || block.type === 'text') {
                if (block.text) { event.sender.send('agent:stream-chunk', requestId, block.text); sentAnyContent = true; }
              } else if (block.type === 'reasoning' || block.type === 'thinking') {
                const t = block.text || block.thinking || '';
                if (t) event.sender.send('agent:stream-thinking', requestId, t);
              }
            }
          }
          if (evt.type === 'text' || evt.type === 'output_text') {
            if (evt.text) { event.sender.send('agent:stream-chunk', requestId, evt.text); sentAnyContent = true; }
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    const timeout = agent.timeout || 300000;
    const timer = setTimeout(() => {
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'Command timeout');
      reject(new Error('Command timeout'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!sentAnyContent && code !== 0 && stderrBuf.trim()) {
        // Codex exited with an error and never sent any content — surface the error
        const errMsg = stderrBuf.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
        event.sender.send('agent:stream-error', requestId, errMsg || `Codex exited with code ${code}`);
      } else {
        event.sender.send('agent:stream-done', requestId, {});
      }
      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      reject(err);
    });
  });
}

async function pingClaudeCode(agent) {
  try {
    const claudePath = agent.claudePath || 'claude';
    const output = await runLocalCommand(claudePath, ['--version'], { timeout: 10000 });
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Provider: OpenClaw Local ──

async function chatOpenClawLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const agentId = agent.openclawAgent || 'main';
  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');
  const workDir = agent.workDir || process.env.HOME;

  let cmd = `openclaw agent --agent '${agentId}' --message '${escapedMsg}' --json 2>&1`;

  try {
    const output = await runLocalCommand('bash', ['-l', '-c', cmd], { cwd: workDir, timeout: 300000 });
    const content = extractOpenClawResponse(output);
    return { content };
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractOpenClawResponse(errMsg);
    if (content && content.length > 10 && !content.includes('Permission denied') && !content.includes('command not found')) {
      return { content };
    }
    return { error: err.message };
  }
}

async function pingOpenClawLocal() {
  try {
    const output = await runLocalCommand('bash', ['-l', '-c', 'openclaw --version 2>&1'], { timeout: 10000 });
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Provider: Hermes Local ──

async function chatHermesLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');
  const workDir = agent.workDir || process.env.HOME;

  let cmd = 'hermes chat';
  if (agent.hermesProvider) cmd += ` --provider '${agent.hermesProvider}'`;
  if (agent.model) cmd += ` --model '${agent.model}'`;
  if (agent.hermesWorktree) cmd += ` --worktree '${agent.hermesWorktree}'`;
  cmd += ` -q '${escapedMsg}' 2>&1`;

  try {
    const output = await runLocalCommand('bash', ['-l', '-c', cmd], { cwd: workDir, timeout: 300000 });
    const content = extractHermesResponse(output);
    return { content };
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractHermesResponse(errMsg);
    if (content && content.length > 10 && !content.includes('Permission denied') && !content.includes('command not found')) {
      return { content };
    }
    return { error: err.message };
  }
}

async function pingHermesLocal() {
  try {
    const output = await runLocalCommand('bash', ['-l', '-c', 'hermes --version 2>&1'], { timeout: 10000 });
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── In-app auth flows (no terminal needed) ──

// Track running auth processes so we can report status
const authProcesses = {};

ipcMain.handle('agent:auth-login', async (_event, agent) => {
  try {
    if (agent.provider === 'claude-code') {
      const claudePath = agent.claudePath || 'claude';

      // Kill any existing auth process for this agent
      if (authProcesses[agent.id]) {
        try { authProcesses[agent.id].kill(); } catch {}
        delete authProcesses[agent.id];
      }

      // We resolve the IPC immediately so the renderer isn't blocked.
      // All real progress is communicated through agent:auth-status events.
      const proc = spawn(claudePath, ['auth', 'login'], {
        env: getLoginEnv(),
        cwd: agent.workDir || process.env.HOME,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let urlOpened = false;

      const sendStatus = (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:auth-status', agent.id, status);
        }
      };

      const handleData = (chunk) => {
        const text = chunk.toString();
        output += text;

        // Forward raw output to the renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:auth-output', agent.id, text);
        }

        // Open the OAuth URL in the browser — only once
        if (!urlOpened) {
          const urlMatch = output.match(/(https?:\/\/[^\s]+)/);
          if (urlMatch) {
            urlOpened = true;
            shell.openExternal(urlMatch[1]);
            sendStatus('waiting-for-code');
          }
        }

        // Detect success in the stream
        const lower = text.toLowerCase();
        if (lower.includes('success') || lower.includes('logged in') || lower.includes('authenticated')) {
          sendStatus('authenticated');
        }
      };

      proc.stdout.on('data', handleData);
      proc.stderr.on('data', handleData);

      const timer = setTimeout(() => {
        proc.kill();
        delete authProcesses[agent.id];
        sendStatus('error');
      }, 180000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        delete authProcesses[agent.id];

        const lower = output.toLowerCase();
        if (code === 0 || lower.includes('success') || lower.includes('logged in') || lower.includes('authenticated')) {
          sendStatus('authenticated');
        } else {
          // Process exited without clear success — send error so UI can recover
          sendStatus('error');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:auth-output', agent.id, output.trim() || `Auth exited with code ${code}`);
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        delete authProcesses[agent.id];
        sendStatus('error');
      });

      authProcesses[agent.id] = proc;

      // Return immediately — the renderer listens for auth-status events
      return { ok: true, pending: true, message: 'Auth started.' };

    } else if (agent.provider === 'openclaw-local') {
      const output = await runLocalCommand('bash', ['-l', '-c', 'openclaw setup 2>&1'], { timeout: 60000 });
      return { ok: true, message: output.trim() };
    } else if (agent.provider === 'hermes-local') {
      const output = await runLocalCommand('bash', ['-l', '-c', 'hermes setup 2>&1'], { timeout: 60000 });
      return { ok: true, message: output.trim() };
    } else {
      return { error: 'In-app auth not supported for this provider.' };
    }
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('agent:auth-status', async (_event, agent) => {
  try {
    if (agent.provider === 'claude-code') {
      const claudePath = agent.claudePath || 'claude';
      const output = await runLocalCommand(claudePath, ['auth', 'status'], {
        cwd: agent.workDir || process.env.HOME,
        timeout: 10000,
      });
      const text = output.toLowerCase();
      const loggedIn = text.includes('logged in') || text.includes('authenticated') || text.includes('valid');
      return { authenticated: loggedIn, detail: output.trim() };
    }
    return { authenticated: false, detail: 'Unknown provider' };
  } catch (err) {
    return { authenticated: false, detail: err.message };
  }
});

// Write a code (or any input) to the running auth process's stdin
ipcMain.handle('agent:auth-send-input', async (_event, agentId, input) => {
  const proc = authProcesses[agentId];
  if (!proc || proc.killed) {
    return { error: 'No auth process running. Click Login to start again.' };
  }
  try {
    proc.stdin.write(input + '\n');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Keep the old handler as a no-op fallback so nothing crashes
ipcMain.handle('agent:open-auth-terminal', async (_event, agent) => {
  // Redirect to the new in-app auth flow
  return { error: 'Please use the Login button instead.' };
});

// ── Provider: Codex (OpenAI) Local ──

function extractCodexResponse(output) {
  // Strip ANSI escape codes and noise
  const cleaned = output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l =>
      l.trim() &&
      !l.startsWith('╭') && !l.startsWith('╰') && !l.startsWith('│') &&
      !l.startsWith('⠋') && !l.startsWith('⠙') && !l.startsWith('⠹') &&
      !l.startsWith('⠸') && !l.startsWith('⠼') && !l.startsWith('⠴') &&
      !l.startsWith('⠦') && !l.startsWith('⠧') && !l.startsWith('⠇') && !l.startsWith('⠏')
    )
    .join('\n')
    .trim();
  return cleaned || output.trim();
}

async function chatCodexLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const codexPath = agent.codexPath || 'codex';
  const workDir = agent.workDir || process.env.HOME;
  const escapedMsg = lastUserMsg.content;

  // Use --experimental-json to get JSONL output (no TTY required),
  // --full-auto so Codex doesn't block waiting for interactive approval,
  // and --skip-git-repo-check so it works outside git repos.
  const args = [escapedMsg, '--experimental-json', '--full-auto', '--skip-git-repo-check'];
  if (agent.model) args.push('--model', agent.model);
  if (agent.codexArgs) {
    args.push(...agent.codexArgs.split(/\s+/).filter(Boolean));
  }

  try {
    const output = await runLocalCommand(codexPath, args, {
      cwd: workDir,
      timeout: agent.timeout || 300000,
    });

    // Parse JSONL output — collect text content and thinking/reasoning
    let content = '';
    let thinking = null;
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        // Collect assistant text output
        if (evt.type === 'message' && evt.message?.content) {
          for (const block of (Array.isArray(evt.message.content) ? evt.message.content : [])) {
            if (block.type === 'output_text' || block.type === 'text') {
              content += (block.text || '');
            } else if (block.type === 'reasoning' || block.type === 'thinking') {
              thinking = (thinking || '') + (block.text || block.thinking || '');
            }
          }
        }
        // Also handle top-level text events
        if (evt.type === 'text' || evt.type === 'output_text') {
          content += (evt.text || '');
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!content) content = extractCodexResponse(output);
    return { content, thinking };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('authentication') || msg.includes('API key')) {
      return { error: 'Codex is not authenticated. Make sure your OPENAI_API_KEY is set.\n\nRun: export OPENAI_API_KEY=your-key\n\nOr add it to your shell profile (~/.zshrc or ~/.bashrc).' };
    }
    return { error: msg };
  }
}

async function pingCodexLocal(agent) {
  try {
    const codexPath = agent.codexPath || 'codex';
    const output = await runLocalCommand(codexPath, ['--version'], { timeout: 10000 });
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

async function chatCodexSSH(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');
  let cmd = `codex '${escapedMsg}'`;
  if (agent.model) cmd += ` --model '${agent.model}'`;
  cmd += ' 2>&1';

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    const content = extractCodexResponse(output);
    return { content };
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractCodexResponse(errMsg);
    if (content && content.length > 10 && !content.includes('Permission denied') && !content.includes('command not found')) {
      return { content };
    }
    return { error: err.message };
  }
}

async function pingCodexSSH(agent) {
  try {
    const output = await runSSHCommand(agent, 'codex --version 2>&1', 15000);
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Slash Commands ──

// Universal local-only commands (always available, handled in renderer)
const LOCAL_COMMANDS = {
  '/clear': { desc: 'Clear chat history' },
  '/status': { desc: 'Check connection status' },
};

// How to discover and execute commands for each provider
const PROVIDER_CONFIG = {
  'claude-code': {
    discoverCmd: (agent) => ({ cli: 'claude', args: ['-p', '/help'], cwd: agent.workDir || process.env.HOME }),
    execCmd: (agent, slashCmd, arg) => ({ cli: 'claude', args: ['-p', `${slashCmd}${arg ? ' ' + arg : ''}`], cwd: agent.workDir || process.env.HOME }),
    parseHelp: (output) => {
      // Parse Claude Code /help output: lines like "/command  description" or "/command - description"
      const cmds = [];
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(\/\w[\w-]*)\s+[-–—:]?\s*(.+)/);
        if (match) {
          const name = match[1].toLowerCase();
          if (!LOCAL_COMMANDS[name]) {
            cmds.push({ name, desc: match[2].trim() });
          }
        }
      }
      return cmds;
    },
  },
  'openclaw': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'openclaw --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => ({ ssh: true, agent, command: `openclaw ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` }),
    parseHelp: parseCLIHelp,
  },
  'openclaw-local': {
    discoverCmd: (agent) => ({ local: true, command: 'openclaw --help 2>&1', cwd: agent.workDir }),
    execCmd: (agent, slashCmd, arg) => ({ local: true, command: `openclaw ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir }),
    parseHelp: parseCLIHelp,
  },
  'hermes': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'hermes --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => ({ ssh: true, agent, command: `hermes ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` }),
    parseHelp: parseCLIHelp,
  },
  'hermes-local': {
    discoverCmd: (agent) => ({ local: true, command: 'hermes --help 2>&1', cwd: agent.workDir }),
    execCmd: (agent, slashCmd, arg) => ({ local: true, command: `hermes ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir }),
    parseHelp: parseCLIHelp,
  },
  'openai-compat': {
    // OpenAI-compat has no CLI, provide a static /models command via special handling
    discoverCmd: null,
    execCmd: (agent, slashCmd, arg) => {
      if (slashCmd === '/models') return { http: true, url: `${agent.baseUrl}/v1/models`, apiKey: agent.apiKey };
      return null;
    },
    staticCmds: [{ name: '/models', desc: 'List available models' }],
    parseHelp: () => [],
  },
  'codex': {
    discoverCmd: (agent) => ({ local: true, command: `${agent.codexPath || 'codex'} --help 2>&1`, cwd: agent.workDir }),
    execCmd: (agent, slashCmd, arg) => ({ local: true, command: `${agent.codexPath || 'codex'} ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir }),
    parseHelp: parseCLIHelp,
  },
  'codex-ssh': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'codex --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => ({ ssh: true, agent, command: `codex ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` }),
    parseHelp: parseCLIHelp,
  },
};

// Generic CLI help parser: extracts subcommands/options from --help output
// Handles common formats:
//   command    Description text
//   command  - Description text
//   command — Description text
//   --flag     Description text
function parseCLIHelp(output) {
  const cmds = [];
  const lines = output.split('\n');
  const seen = new Set();
  for (const line of lines) {
    // Match "  subcommand   description" patterns (indented, at least 2 spaces between name and desc)
    const match = line.match(/^\s{1,8}([\w][\w-]*)\s{2,}[-–—:]?\s*(.+)/);
    if (match) {
      const name = '/' + match[1].toLowerCase();
      if (!LOCAL_COMMANDS[name] && !seen.has(name)) {
        seen.add(name);
        cmds.push({ name, desc: match[2].trim() });
      }
    }
  }
  // If we got nothing useful, add a /help fallback
  if (cmds.length === 0) {
    cmds.push({ name: '/help', desc: 'Show help output' });
  }
  return cmds;
}

// Cache discovered commands: key = provider + agent-id, value = { commands, timestamp }
const discoveredCommandsCache = new Map();
const DISCOVERY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function discoverCommands(agent) {
  const provider = agent.provider;
  const config = PROVIDER_CONFIG[provider];
  if (!config) return [];

  const cacheKey = `${provider}:${agent.id || 'default'}`;
  const cached = discoveredCommandsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < DISCOVERY_CACHE_TTL) {
    return cached.commands;
  }

  // Start with local commands
  let commands = Object.entries(LOCAL_COMMANDS).map(([name, info]) => ({ name, desc: info.desc }));

  // Add static commands if any
  if (config.staticCmds) {
    commands = commands.concat(config.staticCmds);
  }

  // Discover dynamic commands from the CLI
  if (config.discoverCmd) {
    try {
      const spec = config.discoverCmd(agent);
      let output = '';

      if (spec.cli) {
        output = await runLocalCommand(spec.cli, spec.args, { cwd: spec.cwd || process.env.HOME, timeout: 15000 });
      } else if (spec.ssh) {
        output = await runSSHCommand(spec.agent || agent, spec.command, 15000);
      } else if (spec.local) {
        output = await runLocalCommand('bash', ['-l', '-c', spec.command], { cwd: spec.cwd || agent.workDir || process.env.HOME, timeout: 15000 });
      }

      if (output) {
        const parsed = config.parseHelp(output);
        // Merge discovered commands (don't duplicate locals)
        const existingNames = new Set(commands.map(c => c.name));
        for (const cmd of parsed) {
          if (!existingNames.has(cmd.name)) {
            commands.push(cmd);
          }
        }
      }
    } catch (err) {
      console.error(`Command discovery failed for ${provider}:`, err.message);
      // Fall through with just local commands
    }
  }

  discoveredCommandsCache.set(cacheKey, { commands, timestamp: Date.now() });
  return commands;
}

ipcMain.handle('agent:slash-commands', async (_event, provider) => {
  // Lightweight version: return cached or local-only commands
  const cacheKey = `${provider}:default`;
  const cached = discoveredCommandsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < DISCOVERY_CACHE_TTL) {
    return cached.commands;
  }
  const config = PROVIDER_CONFIG[provider] || {};
  const commands = Object.entries(LOCAL_COMMANDS).map(([name, info]) => ({ name, desc: info.desc }));
  if (config.staticCmds) commands.push(...config.staticCmds);
  return commands;
});

// Full discovery: pass the agent object to discover commands from the CLI
ipcMain.handle('agent:discover-slash-commands', async (_event, agent) => {
  const commands = await discoverCommands(agent);
  // Also cache under the default key so getSlashCommands returns them
  const defaultKey = `${agent.provider}:default`;
  discoveredCommandsCache.set(defaultKey, { commands, timestamp: Date.now() });
  return commands;
});

ipcMain.handle('agent:exec-slash', async (_event, agent, command) => {
  const parts = command.trim().split(/\s+/);
  const slashCmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  const provider = agent.provider;

  // Local-only commands (clear, status) are handled in the renderer
  if (LOCAL_COMMANDS[slashCmd]) {
    return { local: true, command: slashCmd };
  }

  const config = PROVIDER_CONFIG[provider];
  if (!config) {
    return { error: `Unknown provider: ${provider}` };
  }

  // If this is /help, also trigger a fresh discovery for the command palette
  if (slashCmd === '/help' && config.discoverCmd) {
    // Invalidate cache so next palette open gets fresh commands
    discoveredCommandsCache.delete(`${provider}:${agent.id || 'default'}`);
    discoveredCommandsCache.delete(`${provider}:default`);
  }

  try {
    const spec = config.execCmd(agent, slashCmd, arg);
    if (!spec) {
      return { error: `Unknown command: ${slashCmd}. Type / to see available commands.` };
    }

    // SSH command
    if (spec.ssh) {
      const output = await runSSHCommand(spec.agent || agent, spec.command, 30000);
      return { content: output.trim() };
    }

    // Local shell command
    if (spec.local) {
      const output = await runLocalCommand('bash', ['-l', '-c', spec.command], { cwd: spec.cwd || agent.workDir || process.env.HOME, timeout: 30000 });
      return { content: output.trim() };
    }

    // CLI command (claude code)
    if (spec.cli) {
      const output = await runLocalCommand(spec.cli, spec.args, { cwd: spec.cwd || process.env.HOME, timeout: 30000 });
      // Trigger discovery after running a command (to pick up new commands from help)
      discoverCommands(agent).catch(() => {});
      return { content: extractClaudeCodeResponse(output) };
    }

    // HTTP request (openai-compat models list)
    if (spec.http) {
      const headers = {};
      if (spec.apiKey) headers['Authorization'] = `Bearer ${spec.apiKey}`;
      const res = await makeRequest(spec.url, { method: 'GET', headers });
      try {
        const data = JSON.parse(res.body);
        if (data.data) {
          const modelNames = data.data.map(m => m.id).join('\n');
          return { content: `Available models:\n${modelNames}` };
        }
        return { content: res.body };
      } catch {
        return { content: res.body };
      }
    }

    return { error: 'Could not execute command' };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC Handlers ──

ipcMain.handle('agent:chat', async (_event, agent, messages) => {
  try {
    if (agent.provider === 'openclaw') return await chatOpenClaw(agent, messages);
    if (agent.provider === 'openclaw-local') return await chatOpenClawLocal(agent, messages);
    if (agent.provider === 'hermes') return await chatHermes(agent, messages);
    if (agent.provider === 'hermes-local') return await chatHermesLocal(agent, messages);
    if (agent.provider === 'claude-code') return await chatClaudeCode(agent, messages);
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
    else if (agent.provider === 'codex') await streamCodexLocal(event, requestId, agent, messages);
    else if (agent.provider === 'openclaw') await streamOpenClaw(event, requestId, agent, messages);
    else if (agent.provider === 'openclaw-local') await streamOpenClaw(event, requestId, agent, messages);
    else if (agent.provider === 'hermes' || agent.provider === 'hermes-local' || agent.provider === 'codex-ssh') {
      // Providers without streaming: run non-streaming chat and emit result as a single chunk
      const chatFn = agent.provider === 'hermes' ? chatHermes
        : agent.provider === 'hermes-local' ? chatHermesLocal
        : chatCodexSSH;
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

ipcMain.handle('agent:ping', async (_event, agent) => {
  try {
    if (agent.provider === 'openclaw') {
      return await pingOpenClaw(agent);
    } else if (agent.provider === 'hermes') {
      return await pingHermes(agent);
    } else if (agent.provider === 'openclaw-local') {
      return await pingOpenClawLocal();
    } else if (agent.provider === 'hermes-local') {
      return await pingHermesLocal();
    } else if (agent.provider === 'claude-code') {
      return await pingClaudeCode(agent);
    } else if (agent.provider === 'codex') {
      return await pingCodexLocal(agent);
    } else if (agent.provider === 'codex-ssh') {
      return await pingCodexSSH(agent);
    } else {
      const url = `${agent.baseUrl}/v1/models`;
      const res = await makeRequest(url, {
        method: 'GET',
        headers: agent.apiKey ? { 'Authorization': `Bearer ${agent.apiKey}` } : {},
      });
      return { online: res.status === 200 };
    }
  } catch (err) {
    return { online: false, error: err.message };
  }
});

// ── Provider: OpenAI-compatible ──

async function chatOpenAI(agent, messages) {
  const url = `${agent.baseUrl}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const body = JSON.stringify({
    model: agent.model || 'gpt-4',
    messages,
    max_tokens: agent.maxTokens || 16384,
    temperature: agent.temperature ?? 0.7,
  });
  const res = await makeRequest(url, { method: 'POST', headers }, body);
  const data = JSON.parse(res.body);
  if (res.status !== 200) return { error: data.error?.message || res.body };
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content || '',
    thinking: msg?.reasoning_content || null,
  };
}

async function streamOpenAI(event, requestId, agent, messages) {
  const url = `${agent.baseUrl}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const body = JSON.stringify({
    model: agent.model || 'gpt-4',
    messages,
    max_tokens: agent.maxTokens || 16384,
    temperature: agent.temperature ?? 0.7,
    stream: true,
  });
  await makeStreamRequest(url, { method: 'POST', headers }, body, event, requestId);
}

