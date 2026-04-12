const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');

let mainWindow;
// Map of requestId -> spawned Claude process (for sending permission responses via stdin)
const activeClaudeProcs = new Map();

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

    let timer = setTimeout(() => {
      proc.kill();
      reject(new Error('SSH command timeout'));
    }, timeout);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { proc.kill(); reject(new Error('SSH command timeout')); }, timeout);
    };

    proc.stdout.on('data', resetTimer);
    proc.stderr.on('data', resetTimer);

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
    // Match runSSHCommand: remote non-interactive shells often do not load the
    // user's PATH, which makes CLI tools like codex appear to hang/fail only in
    // streaming mode.
    const wrappedCommand = `bash -l -c ${JSON.stringify(command)}`;
    args.push(`${sshUser}@${sshHost}`, wrappedCommand);

    const proc = spawn('ssh', args);
    let fullOutput = '';
    let stderrOutput = '';
    let sawStdout = false;
    let settled = false;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      sawStdout = true;
      fullOutput += text;
      event.sender.send('agent:stream-chunk', requestId, text);
    });

    proc.stderr.on('data', (chunk) => {
      // Some stderr is normal for SSH, ignore connection messages
      const text = chunk.toString();
      if (!text.includes('Warning:') && !text.includes('Permanently added')) {
        stderrOutput += text;
        fullOutput += text;
      }
    });

    let timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'SSH command timeout');
      resolve(fullOutput);
    }, timeout);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        event.sender.send('agent:stream-error', requestId, 'SSH command timeout');
        resolve(fullOutput);
      }, timeout);
    };

    proc.stdout.on('data', resetTimer);
    proc.stderr.on('data', resetTimer);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !sawStdout) {
        event.sender.send('agent:stream-error', requestId, stderrOutput.trim() || `SSH command exited with code ${code}`);
      } else {
        event.sender.send('agent:stream-done', requestId, {});
      }
      resolve(fullOutput);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
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

// ── Provider: Claude Code (via @anthropic-ai/claude-code SDK) ──
// Uses the official @anthropic-ai/claude-code SDK instead of spawning the CLI.
// This inherits the same OAuth tokens from `claude auth login` — no API key needed.
let _claudeSDK = null;
async function getClaudeSDK() {
  if (!_claudeSDK) {
    try {
      _claudeSDK = await import('@anthropic-ai/claude-code');
    } catch {
      throw new Error(
        'Claude Code SDK not installed. Run: npm install @anthropic-ai/claude-code'
      );
    }
  }
  return _claudeSDK;
}

// Build SDK options from the agent config object
function buildClaudeSDKOptions(agent, extraOpts = {}) {
  const options = {
    cwd: agent.workDir || process.env.HOME,
    ...extraOpts,
  };

  if (agent.model) options.model = agent.model;

  // Permission mode
  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    options.dangerouslySkipPermissions = true;
  } else {
    options.permissionMode = permMode;
  }

  // Allowed tools whitelist
  if (agent.allowedTools) {
    options.allowedTools = agent.allowedTools
      .split(/[,\s]+/)
      .filter(Boolean);
  }

  // Session continuation
  if (agent.sessionId) {
    options.resume = agent.sessionId;
  } else if (agent.continueSession) {
    options.continue = true;
  }

  // System prompt override
  if (agent.systemPrompt) {
    options.systemPrompt = agent.systemPrompt;
  }

  return options;
}

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
    let timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Command timeout'));
    }, timeout);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { proc.kill(); reject(new Error('Command timeout')); }, timeout);
    };

    proc.stdout.on('data', resetTimer);
    proc.stderr.on('data', resetTimer);

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

  try {
    const { query } = await getClaudeSDK();
    const options = buildClaudeSDKOptions(agent);

    let content = '';
    let thinking = null;
    let sessionId = null;

    for await (const message of query({ prompt: lastUserMsg.content, options })) {
      // Init message — contains session_id
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
      }

      // Complete assistant messages
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') content += block.text || '';
          if (block.type === 'thinking') thinking = (thinking || '') + (block.thinking || '');
        }
      }

      // Result message — final answer + session_id
      if (message.type === 'result') {
        sessionId = message.session_id || sessionId;
        if (message.result) content = message.result;
      }
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

  try {
    const { query } = await getClaudeSDK();

    const abortController = new AbortController();
    const pendingPermissions = new Map(); // toolUseId -> resolve callback

    // Store handles so the IPC permission-response handler and abort can reach us
    activeClaudeProcs.set(requestId, {
      abort: () => abortController.abort(),
      resolvePermission: (toolUseId, decision) => {
        const resolver = pendingPermissions.get(toolUseId);
        if (resolver) {
          resolver(decision);
          pendingPermissions.delete(toolUseId);
        }
      },
    });

    const options = buildClaudeSDKOptions(agent, {
      signal: abortController.signal,
      // Enable partial messages so we get real-time text deltas
      includePartialMessages: true,
    });

    let sessionId = null;
    const seenTextBlocks = new Set(); // track blocks we've already streamed via deltas

    for await (const message of query({ prompt: lastUserMsg.content, options })) {

      // ── System init — session ID + available slash commands ──
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        continue;
      }

      // ── Partial streaming events (real-time token-by-token deltas) ──
      if (message.type === 'stream_event' && message.event) {
        const evt = message.event;
        if (evt.type === 'content_block_delta') {
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            event.sender.send('agent:stream-chunk', requestId, evt.delta.text);
          }
          if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
            event.sender.send('agent:stream-thinking', requestId, evt.delta.thinking);
          }
          if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
            // Tool input streaming — could surface later if needed
          }
        }
        // Mark content blocks streamed via deltas so we skip them in complete messages
        if (evt.type === 'content_block_start' && evt.index != null) {
          seenTextBlocks.add(evt.index);
        }
        continue;
      }

      // ── Complete assistant messages (tool_use blocks arrive here) ──
      if (message.type === 'assistant' && message.message?.content) {
        for (let i = 0; i < message.message.content.length; i++) {
          const block = message.message.content[i];

          // Tool use — always emit (these aren't streamed token-by-token)
          if (block.type === 'tool_use') {
            event.sender.send('agent:stream-tool-use', requestId, {
              id: block.id,
              tool: block.name,
              input: block.input,
            });
          }

          // Text/thinking that wasn't already sent via deltas (fallback)
          if (!seenTextBlocks.has(i)) {
            if (block.type === 'text' && block.text) {
              event.sender.send('agent:stream-chunk', requestId, block.text);
            }
            if (block.type === 'thinking' && block.thinking) {
              event.sender.send('agent:stream-thinking', requestId, block.thinking);
            }
          }
        }
        seenTextBlocks.clear();
      }

      // ── Result ──
      if (message.type === 'result') {
        sessionId = message.session_id || sessionId;
      }
    }

    activeClaudeProcs.delete(requestId);
    event.sender.send('agent:stream-done', requestId, { sessionId });

  } catch (err) {
    activeClaudeProcs.delete(requestId);
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('authentication_error') || msg.includes('Failed to authenticate')) {
      event.sender.send('agent:stream-error', requestId, 'Claude Code is not authenticated. Click Login below to sign in.');
    } else {
      event.sender.send('agent:stream-error', requestId, msg);
    }
  }
}

async function streamCodexLocal(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  if (agent.useCodexSDK !== false) {
    try {
      const usedAgentsSDK = await streamCodexWithAgentsSDK(event, requestId, agent, lastUserMsg.content);
      if (usedAgentsSDK) return;

      await streamCodexWithCodexSDK(event, requestId, agent, lastUserMsg.content);
      return;
    } catch (err) {
      activeClaudeProcs.delete(requestId);
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
        event.sender.send('agent:stream-error', requestId, 'Codex is not authenticated. Run "codex auth" or set OPENAI_API_KEY.');
      } else {
        event.sender.send('agent:stream-error', requestId, msg);
      }
      return;
    }
  }

  // Check if codex has ChatGPT auth
  const fs = require('fs');
  const homeDir = require('os').homedir();
  const codexAuthPath = path.join(homeDir, '.codex', 'auth.json');
  let hasCodexAuth = false;
  try {
    if (fs.existsSync(codexAuthPath)) {
      const authData = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
      hasCodexAuth = authData.auth_mode === 'chatgpt' && authData.tokens && authData.tokens.id_token;
    }
  } catch (e) {
    // Auth file might be corrupted or inaccessible
  }

  // If we have ChatGPT auth, use the codex CLI
  if (hasCodexAuth) {
    const codexPath = agent.codexPath || 'codex';
    const workDir = agent.workDir || process.env.HOME;

    return new Promise((resolve, reject) => {
      const args = buildCodexExecArgs(agent, { stdinPrompt: true });

      // Use Codex's non-interactive entrypoint; the default TUI requires a TTY.
      const proc = spawn(codexPath, args, {
        env: { ...getLoginEnv() },
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Send the message via stdin
      proc.stdin.write(lastUserMsg.content);
      proc.stdin.end();

      let buffer = '';
      let stderrBuf = '';
      let sentAnyContent = false;

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        // Send raw output as it comes
        event.sender.send('agent:stream-chunk', requestId, text);
        sentAnyContent = true;
      });

      proc.stderr.on('data', (data) => {
        stderrBuf += data.toString();
      });

      const timeout = agent.timeout || 300000;
      let timer = setTimeout(() => {
        proc.kill();
        event.sender.send('agent:stream-error', requestId, 'Command timeout');
        resolve();
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!sentAnyContent && code !== 0 && stderrBuf.trim()) {
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
        resolve();
      });
    });
  }

  // Prefer SDK if API key is available and no ChatGPT auth
  const apiKey = agent.apiKey || process.env.OPENAI_API_KEY;
  if (apiKey && agent.useSDK !== false) {
    try {
      const openai = await getOpenAISDK(apiKey);

      // Build proper messages array for OpenAI
      const formattedMessages = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      const stream = await openai.chat.completions.create({
        model: agent.model || 'gpt-4o',
        messages: formattedMessages,
        max_tokens: agent.maxTokens || 16384,
        temperature: agent.temperature ?? 0.7,
        stream: true,
      });

      // Handle abortions
      const abortController = new AbortController();
      const activeHandle = {
        abort: () => abortController.abort()
      };
      activeClaudeProcs.set(requestId, activeHandle);

      try {
        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;

          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            event.sender.send('agent:stream-chunk', requestId, delta.content);
          }
          // Check for reasoning content (o1 models)
          if (delta?.reasoning_content) {
            event.sender.send('agent:stream-thinking', requestId, delta.reasoning_content);
          }
        }
      } finally {
        activeClaudeProcs.delete(requestId);
      }

      event.sender.send('agent:stream-done', requestId, {});
      return;
    } catch (err) {
      activeClaudeProcs.delete(requestId);
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('authentication')) {
        event.sender.send('agent:stream-error', requestId, 'Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
      } else if (msg.includes('429')) {
        event.sender.send('agent:stream-error', requestId, 'Rate limit exceeded. Please try again later.');
      } else {
        event.sender.send('agent:stream-error', requestId, msg);
      }
      return;
    }
  }

  // Fallback - need either ChatGPT auth or API key
  event.sender.send('agent:stream-error', requestId,
    'Codex requires authentication. You have two options:\n\n' +
    'Option 1: Login with ChatGPT (recommended):\n' +
    '   Run: codex auth\n' +
    '   This will open a browser to login with your ChatGPT account\n\n' +
    'Option 2: Use an OpenAI API key:\n' +
    '   • Add an API key to your agent configuration, or\n' +
    '   • Set OPENAI_API_KEY environment variable:\n' +
    '     export OPENAI_API_KEY=your-key-here\n\n' +
    'Get your API key from: https://platform.openai.com/api-keys'
  );
  return;
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

// ── Provider: Claude Code SSH ──

async function chatClaudeCodeSSH(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  // Escape for double quotes: backslash, dollar sign, backtick, double quote
  const escapedMsg = lastUserMsg.content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  const workDir = agent.workDir || '~';

  // Build claude command — use -p (print mode) for non-interactive usage
  let cmd = `cd ${workDir} && claude -p --output-format json`;
  if (agent.model) cmd += ` --model '${agent.model}'`;

  // Session continuation - mirror the local logic exactly
  if (agent.sessionId) {
    cmd += ` --resume '${agent.sessionId}'`;
  } else if (agent.continueSession) {
    cmd += ` --continue`;
  }

  // Add permission mode
  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    cmd += ' --dangerously-skip-permissions';
  } else {
    cmd += ` --permission-mode '${permMode}'`;
  }

  // Add allowed tools whitelist
  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean).join(',');
    cmd += ` --allowedTools '${tools}'`;
  }

  // Add system prompt override
  if (agent.systemPrompt) {
    const escapedPrompt = agent.systemPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    cmd += ` --system-prompt "${escapedPrompt}"`;
  }

  // Add the message using double quotes
  cmd += ` "${escapedMsg}" 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    // Try parsing JSON output first
    try {
      const data = JSON.parse(output);
      return { content: data.result || data.content || data.text || output.trim(), sessionId: data.session_id };
    } catch {
      // Fall back to text extraction
      const content = extractClaudeCodeResponse(output);
      return { content };
    }
  } catch (err) {
    const errMsg = err.message || '';
    if (errMsg.includes('401') || errMsg.includes('authentication') || errMsg.includes('not authenticated')) {
      return { error: 'Claude Code on remote is not authenticated. SSH into the machine and run: claude auth login' };
    }
    const content = extractClaudeCodeResponse(errMsg);
    if (content && content.length > 10 && !content.includes('Permission denied') && !content.includes('command not found')) {
      return { content };
    }
    return { error: err.message };
  }
}

async function streamClaudeCodeSSH(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  // Escape for double quotes: backslash, dollar sign, backtick, double quote
  const escapedMsg = lastUserMsg.content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  const workDir = agent.workDir || '~';

  // Build claude command — use -p with stream-json for real-time NDJSON streaming
  let cmd = `cd ${workDir} && claude -p --output-format stream-json --verbose --include-partial-messages`;
  if (agent.model) cmd += ` --model '${agent.model}'`;

  // Session continuation - mirror the local logic exactly
  if (agent.sessionId) {
    cmd += ` --resume '${agent.sessionId}'`;
  } else if (agent.continueSession) {
    cmd += ` --continue`;
  }

  // Add permission mode
  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    cmd += ' --dangerously-skip-permissions';
  } else {
    cmd += ` --permission-mode '${permMode}'`;
  }

  // Add allowed tools whitelist
  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean).join(',');
    cmd += ` --allowedTools '${tools}'`;
  }

  // Add system prompt override
  if (agent.systemPrompt) {
    const escapedPrompt = agent.systemPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    cmd += ` --system-prompt "${escapedPrompt}"`;
  }

  // Add the message using double quotes
  cmd += ` "${escapedMsg}"`;

  // Spawn SSH directly and parse NDJSON for proper streaming
  const sshUser = agent.sshUser || 'root';
  const sshHost = agent.sshHost;
  const sshPort = agent.sshPort || 22;
  const sshKey = agent.sshKey || '';

  const sshArgs = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-p', String(sshPort),
  ];
  if (sshKey) sshArgs.push('-i', sshKey);
  const wrappedCommand = `bash -l -c ${JSON.stringify(cmd)}`;
  sshArgs.push(`${sshUser}@${sshHost}`, wrappedCommand);

  const proc = spawn('ssh', sshArgs);
  let buffer = '';
  let stderrOutput = '';
  let sessionId = null;
  let settled = false;
  const seenDeltaBlocks = new Set(); // track blocks streamed via deltas to avoid duplicates

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // System init — capture session ID
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
          continue;
        }

        // Content block deltas — token-by-token streaming
        if (msg.type === 'content_block_delta') {
          if (msg.delta?.type === 'text_delta' && msg.delta.text) {
            event.sender.send('agent:stream-chunk', requestId, msg.delta.text);
          }
          if (msg.delta?.type === 'thinking_delta' && msg.delta.thinking) {
            event.sender.send('agent:stream-thinking', requestId, msg.delta.thinking);
          }
          continue;
        }

        // Content block start — track blocks for deduplication
        if (msg.type === 'content_block_start' && msg.index != null) {
          seenDeltaBlocks.add(msg.index);
          continue;
        }

        // Complete assistant messages — emit tool_use blocks and any text not already streamed
        if (msg.type === 'assistant' && msg.message?.content) {
          for (let i = 0; i < msg.message.content.length; i++) {
            const block = msg.message.content[i];
            if (block.type === 'tool_use') {
              event.sender.send('agent:stream-tool-use', requestId, {
                id: block.id,
                tool: block.name,
                input: block.input,
              });
            }
            // Only emit text/thinking if not already sent via deltas
            if (!seenDeltaBlocks.has(i)) {
              if (block.type === 'text' && block.text) {
                event.sender.send('agent:stream-chunk', requestId, block.text);
              }
              if (block.type === 'thinking' && block.thinking) {
                event.sender.send('agent:stream-thinking', requestId, block.thinking);
              }
            }
          }
          seenDeltaBlocks.clear();
          continue;
        }

        // Result — capture final session ID
        if (msg.type === 'result') {
          sessionId = msg.session_id || sessionId;
          continue;
        }
      } catch {
        // Not valid JSON — emit as raw text (shouldn't happen with stream-json)
        if (line.trim()) {
          event.sender.send('agent:stream-chunk', requestId, line);
        }
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('Warning:') && !text.includes('Permanently added')) {
      stderrOutput += text;
    }
  });

  let timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    proc.kill();
    event.sender.send('agent:stream-error', requestId, 'SSH command timeout');
  }, 600000);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'SSH command timeout');
    }, 600000);
  };
  proc.stdout.on('data', resetTimer);
  proc.stderr.on('data', resetTimer);

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (settled) return resolve();
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && stderrOutput.trim()) {
        const errMsg = stderrOutput.trim();
        if (errMsg.includes('401') || errMsg.includes('authentication') || errMsg.includes('not authenticated')) {
          event.sender.send('agent:stream-error', requestId, 'Claude Code on remote is not authenticated. SSH into the machine and run: claude auth login');
        } else {
          event.sender.send('agent:stream-error', requestId, errMsg);
        }
      } else {
        event.sender.send('agent:stream-done', requestId, { sessionId });
      }
      resolve();
    });

    proc.on('error', (err) => {
      if (settled) return resolve();
      settled = true;
      clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      resolve();
    });
  });
}

async function pingClaudeCodeSSH(agent) {
  try {
    const output = await runSSHCommand(agent, 'claude --version 2>&1', 15000);
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Provider: Codex (OpenAI) Local ──

// OpenAI SDK integration
let _openaiClient = null;
async function getOpenAISDK(apiKey) {
  if (!_openaiClient || (_openaiClient._apiKey !== apiKey && apiKey)) {
    try {
      const OpenAI = (await import('openai')).default;
      _openaiClient = new OpenAI({
        apiKey: apiKey || process.env.OPENAI_API_KEY,
        dangerouslyAllowBrowser: false // We're in Electron main process
      });
      _openaiClient._apiKey = apiKey; // Store for comparison
    } catch (err) {
      throw new Error('OpenAI SDK not installed. Run: npm install openai');
    }
  }
  return _openaiClient;
}

let _openAIAgentsSDK = null;
async function getOpenAIAgentsSDK() {
  if (!_openAIAgentsSDK) {
    try {
      _openAIAgentsSDK = await import('@openai/agents');
    } catch {
      throw new Error('OpenAI Agents SDK not installed. Run: npm install @openai/agents @openai/agents-extensions @openai/codex-sdk');
    }
  }
  return _openAIAgentsSDK;
}

let _openAICodexToolSDK = null;
async function getOpenAICodexToolSDK() {
  if (!_openAICodexToolSDK) {
    try {
      _openAICodexToolSDK = await import('@openai/agents-extensions/experimental/codex');
    } catch {
      throw new Error('OpenAI Codex tool extension not installed. Run: npm install @openai/agents-extensions @openai/codex-sdk');
    }
  }
  return _openAICodexToolSDK;
}

let _codexSDK = null;
async function getCodexSDK() {
  if (!_codexSDK) {
    try {
      _codexSDK = await import('@openai/codex-sdk');
    } catch {
      throw new Error('Codex SDK not installed. Run: npm install @openai/codex-sdk');
    }
  }
  return _codexSDK;
}

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

function buildCodexExecArgs(agent, { stdinPrompt = false } = {}) {
  const args = ['exec', '--full-auto', '--color', 'never'];
  if (agent.skipGitRepoCheck !== false) args.push('--skip-git-repo-check');
  if (agent.model) args.push('--model', agent.model);
  if (agent.codexArgs) args.push(...agent.codexArgs.split(/\s+/).filter(Boolean));
  if (stdinPrompt) args.push('-');
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellQuoteRemotePath(filePath) {
  if (!filePath || filePath === '~') return '~';
  if (filePath.startsWith('~/')) return `~/${shellQuote(filePath.slice(2))}`;
  return shellQuote(filePath);
}

function buildRemoteCdCommand(workDir) {
  return `cd -- ${shellQuoteRemotePath(workDir || '~')}`;
}

function buildCodexExecShellCommand(agent, { stdinPrompt = false } = {}) {
  const parts = ['codex', 'exec', '--full-auto', '--color', 'never'];
  if (agent.skipGitRepoCheck !== false) parts.push('--skip-git-repo-check');
  if (agent.model) parts.push('--model', shellQuote(agent.model));
  if (agent.codexArgs) parts.push(agent.codexArgs);
  if (stdinPrompt) parts.push('-');
  return parts.join(' ');
}

function expandHomeDir(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function getCodexApiKey(agent) {
  const env = getLoginEnv();
  return agent.apiKey || env.CODEX_API_KEY || env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';
}

function buildCodexSDKOptions(agent, apiKey) {
  const env = { ...getLoginEnv() };
  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  const options = { env };
  if (agent.codexPath) options.codexPathOverride = agent.codexPath;
  if (agent.baseUrl) options.baseUrl = agent.baseUrl;
  if (apiKey) options.apiKey = apiKey;
  if (agent.codexConfig) options.config = agent.codexConfig;
  return options;
}

function buildCodexThreadOptions(agent) {
  const options = {
    sandboxMode: agent.sandboxMode || 'workspace-write',
    workingDirectory: expandHomeDir(agent.workDir) || process.env.HOME,
    skipGitRepoCheck: agent.skipGitRepoCheck !== false,
    approvalPolicy: agent.approvalPolicy || 'never',
    webSearchEnabled: !!agent.webSearchEnabled,
  };

  if (agent.model) options.model = agent.model;
  if (agent.reasoningEffort) options.modelReasoningEffort = agent.reasoningEffort;
  if (typeof agent.networkAccessEnabled === 'boolean') options.networkAccessEnabled = agent.networkAccessEnabled;
  if (Array.isArray(agent.additionalDirectories)) options.additionalDirectories = agent.additionalDirectories.map(expandHomeDir);
  return options;
}

function createCodexEventForwarder(event, requestId) {
  let threadId = null;
  let sentAnyContent = false;
  const itemTextLengths = new Map();
  const toolState = new Map();

  const sendTextDelta = (channel, item) => {
    const text = item?.text || '';
    if (!text) return;

    const previousLength = itemTextLengths.get(item.id) || 0;
    const delta = text.slice(previousLength);
    itemTextLengths.set(item.id, text.length);

    if (delta) {
      event.sender.send(channel, requestId, delta);
      if (channel === 'agent:stream-chunk') sentAnyContent = true;
    }
  };

  const sendToolUse = (item) => {
    if (!item?.id) return;

    let tool = item.type;
    let input = {};

    if (item.type === 'command_execution') {
      tool = 'codex_command';
      input = { command: item.command, status: item.status, exit_code: item.exit_code };
    } else if (item.type === 'file_change') {
      tool = 'codex_file_change';
      input = { status: item.status, changes: item.changes };
    } else if (item.type === 'mcp_tool_call') {
      tool = `codex_mcp:${item.server}/${item.tool}`;
      input = { arguments: item.arguments, status: item.status, error: item.error };
    } else if (item.type === 'web_search') {
      tool = 'codex_web_search';
      input = { query: item.query };
    } else if (item.type === 'todo_list') {
      tool = 'codex_todo_list';
      input = { items: item.items };
    } else {
      return;
    }

    const signature = JSON.stringify({ tool, input });
    if (toolState.get(item.id) === signature) return;
    toolState.set(item.id, signature);

    event.sender.send('agent:stream-tool-use', requestId, {
      id: item.id,
      tool,
      input,
    });
  };

  const handleItem = (item) => {
    if (!item) return;
    if (item.type === 'agent_message') {
      sendTextDelta('agent:stream-chunk', item);
    } else if (item.type === 'reasoning') {
      sendTextDelta('agent:stream-thinking', item);
    } else if (item.type === 'error') {
      event.sender.send('agent:stream-error', requestId, item.message || 'Codex error');
    } else {
      sendToolUse(item);
    }
  };

  return {
    get threadId() { return threadId; },
    get sentAnyContent() { return sentAnyContent; },
    handle(payload) {
      const codexEvent = payload?.event || payload;
      if (!codexEvent) return;

      if (payload?.threadId) threadId = payload.threadId;
      if (codexEvent.type === 'thread.started') {
        threadId = codexEvent.thread_id;
      } else if (codexEvent.type === 'item.started' || codexEvent.type === 'item.updated' || codexEvent.type === 'item.completed') {
        handleItem(codexEvent.item);
      } else if (codexEvent.type === 'turn.failed') {
        event.sender.send('agent:stream-error', requestId, codexEvent.error?.message || 'Codex turn failed');
      } else if (codexEvent.type === 'error') {
        event.sender.send('agent:stream-error', requestId, codexEvent.message || 'Codex error');
      }
    },
    markContentSent() {
      sentAnyContent = true;
    },
  };
}

async function streamCodexWithAgentsSDK(event, requestId, agent, prompt) {
  const apiKey = getCodexApiKey(agent);
  if (!apiKey) return false;

  const { Agent, run, setDefaultOpenAIKey } = await getOpenAIAgentsSDK();
  const { codexTool } = await getOpenAICodexToolSDK();

  setDefaultOpenAIKey(apiKey);

  const abortController = new AbortController();
  activeClaudeProcs.set(requestId, {
    abort: () => abortController.abort(),
  });

  const forwarder = createCodexEventForwarder(event, requestId);
  const context = {};
  if (agent.sessionId) context.codexThreadId = agent.sessionId;

  const tool = codexTool({
    codexOptions: buildCodexSDKOptions(agent, apiKey),
    defaultThreadOptions: buildCodexThreadOptions(agent),
    defaultTurnOptions: { signal: abortController.signal },
    useRunContextThreadId: true,
    onStream: async (codexEvent) => {
      forwarder.handle(codexEvent);
    },
  });

  const codexAgent = new Agent({
    name: agent.name || 'Codex',
    model: agent.agentModel || agent.model || 'gpt-5.4',
    instructions: [
      agent.systemPrompt || '',
      'For every user request, call the codex tool exactly once with one text input containing the request. Do not answer directly unless the tool is unavailable.',
    ].filter(Boolean).join('\n\n'),
    tools: [tool],
    toolUseBehavior: 'stop_on_first_tool',
  });

  const result = await run(codexAgent, prompt, {
    stream: true,
    context,
    maxTurns: 3,
    signal: abortController.signal,
  });

  try {
    for await (const streamEvent of result) {
      if (streamEvent.type === 'run_item_stream_event' && streamEvent.name === 'tool_called') {
        const rawItem = streamEvent.item?.rawItem || {};
        event.sender.send('agent:stream-tool-use', requestId, {
          id: rawItem.id || rawItem.callId || rawItem.call_id || 'codex',
          tool: rawItem.name || 'codex',
          input: rawItem.arguments || {},
        });
      }
    }
    await result.completed;

    if (!forwarder.sentAnyContent && result.finalOutput) {
      const text = typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput, null, 2);
      event.sender.send('agent:stream-chunk', requestId, text);
      forwarder.markContentSent();
    }

    event.sender.send('agent:stream-done', requestId, { sessionId: context.codexThreadId || forwarder.threadId || null });
    return true;
  } finally {
    activeClaudeProcs.delete(requestId);
  }
}

async function streamCodexWithCodexSDK(event, requestId, agent, prompt) {
  const { Codex } = await getCodexSDK();
  const apiKey = getCodexApiKey(agent);
  const codex = new Codex(buildCodexSDKOptions(agent, apiKey));
  const threadOptions = buildCodexThreadOptions(agent);
  const thread = agent.sessionId ? codex.resumeThread(agent.sessionId, threadOptions) : codex.startThread(threadOptions);
  const abortController = new AbortController();
  const forwarder = createCodexEventForwarder(event, requestId);

  activeClaudeProcs.set(requestId, {
    abort: () => abortController.abort(),
  });

  try {
    const { events } = await thread.runStreamed(prompt, { signal: abortController.signal });
    for await (const codexEvent of events) {
      forwarder.handle(codexEvent);
    }
    event.sender.send('agent:stream-done', requestId, { sessionId: thread.id || forwarder.threadId || null });
  } finally {
    activeClaudeProcs.delete(requestId);
  }
}

async function chatCodexWithCodexSDK(agent, prompt) {
  const { Codex } = await getCodexSDK();
  const apiKey = getCodexApiKey(agent);
  const codex = new Codex(buildCodexSDKOptions(agent, apiKey));
  const threadOptions = buildCodexThreadOptions(agent);
  const thread = agent.sessionId ? codex.resumeThread(agent.sessionId, threadOptions) : codex.startThread(threadOptions);
  const turn = await thread.run(prompt);
  return { content: turn.finalResponse || '', sessionId: thread.id, usage: turn.usage };
}

async function chatCodexLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  if (agent.useCodexSDK !== false) {
    try {
      return await chatCodexWithCodexSDK(agent, lastUserMsg.content);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
        return { error: 'Codex is not authenticated. Run "codex auth" or set OPENAI_API_KEY.' };
      }
      return { error: msg };
    }
  }

  // Check if codex has ChatGPT auth
  const fs = require('fs');
  const homeDir = require('os').homedir();
  const codexAuthPath = path.join(homeDir, '.codex', 'auth.json');
  let hasCodexAuth = false;
  try {
    if (fs.existsSync(codexAuthPath)) {
      const authData = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
      hasCodexAuth = authData.auth_mode === 'chatgpt' && authData.tokens && authData.tokens.id_token;
    }
  } catch (e) {
    // Auth file might be corrupted or inaccessible
  }

  // If we have ChatGPT auth, use the codex CLI
  if (hasCodexAuth) {
    const codexPath = agent.codexPath || 'codex';
    const workDir = agent.workDir || process.env.HOME;

    try {
      const args = buildCodexExecArgs(agent, { stdinPrompt: true });

      // Use Codex's non-interactive entrypoint; the default TUI requires a TTY.
      const proc = spawn(codexPath, args, {
        env: { ...getLoginEnv() },
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Send the message via stdin and get the response
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        proc.stdin.write(lastUserMsg.content);
        proc.stdin.end();

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        const timeout = agent.timeout || 300000;
        let timer = setTimeout(() => {
          proc.kill();
          reject(new Error('Command timeout'));
        }, timeout);

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (stdout.trim()) {
            const content = extractCodexResponse(stdout);
            resolve({ content });
          } else if (code === 0) {
            resolve({ content: '' });
          } else {
            reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      return { error: err.message };
    }
  }

  // Prefer SDK if API key is available and no ChatGPT auth
  const apiKey = agent.apiKey || process.env.OPENAI_API_KEY;
  if (apiKey && agent.useSDK !== false) {
    try {
      const openai = await getOpenAISDK(apiKey);

      // Build proper messages array for OpenAI
      const formattedMessages = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      const completion = await openai.chat.completions.create({
        model: agent.model || 'gpt-4o',
        messages: formattedMessages,
        max_tokens: agent.maxTokens || 16384,
        temperature: agent.temperature ?? 0.7,
      });

      const msg = completion.choices?.[0]?.message;
      return {
        content: msg?.content || '',
        thinking: msg?.reasoning_content || null,
        usage: completion.usage
      };
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('authentication')) {
        return { error: 'Invalid OpenAI API key. Please check your OPENAI_API_KEY.' };
      }
      if (msg.includes('429')) {
        return { error: 'Rate limit exceeded. Please try again later.' };
      }
      return { error: msg };
    }
  }

  // Fallback - need either ChatGPT auth or API key
  return {
    error: 'Codex requires authentication. You have two options:\n\n' +
           'Option 1: Login with ChatGPT (recommended):\n' +
           '   Run: codex auth\n' +
           '   This will open a browser to login with your ChatGPT account\n\n' +
           'Option 2: Use an OpenAI API key:\n' +
           '   • Add an API key to your agent configuration, or\n' +
           '   • Set OPENAI_API_KEY environment variable:\n' +
           '     export OPENAI_API_KEY=your-key-here\n\n' +
           'Get your API key from: https://platform.openai.com/api-keys'
  };
}

async function pingCodexLocal(agent) {
  // Check if codex has ChatGPT auth
  const fs = require('fs');
  const homeDir = require('os').homedir();
  const codexAuthPath = path.join(homeDir, '.codex', 'auth.json');
  let hasCodexAuth = false;
  try {
    if (fs.existsSync(codexAuthPath)) {
      const authData = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
      hasCodexAuth = authData.auth_mode === 'chatgpt' && authData.tokens && authData.tokens.id_token;
    }
  } catch (e) {
    // Auth file might be corrupted or inaccessible
  }

  if (hasCodexAuth) {
    try {
      const codexPath = agent.codexPath || 'codex';
      const output = await runLocalCommand(codexPath, ['--version'], { timeout: 10000 });
      return { online: true, info: `Codex (ChatGPT auth): ${output.trim()}` };
    } catch (err) {
      return { online: false, error: err.message };
    }
  }

  // Try SDK if API key is available
  const apiKey = agent.apiKey || process.env.OPENAI_API_KEY;
  if (apiKey && agent.useSDK !== false) {
    try {
      const openai = await getOpenAISDK(apiKey);
      // Test the connection by fetching models
      const models = await openai.models.list();
      const modelCount = models.data?.length || 0;
      return {
        online: true,
        info: `OpenAI SDK connected (${modelCount} models available)`
      };
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('authentication')) {
        return { online: false, error: 'Invalid OpenAI API key' };
      }
      return { online: false, error: msg };
    }
  }

  // Fallback message - need auth
  return {
    online: false,
    error: 'Codex needs authentication. Run "codex auth" to login with ChatGPT or set OPENAI_API_KEY.'
  };
}

async function chatCodexSSH(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const workDir = agent.workDir || '~';

  // Check for ChatGPT auth or API key
  let authCheck = '';
  try {
    authCheck = await runSSHCommand(agent,
      `test -f ~/.codex/auth.json && cat ~/.codex/auth.json | grep -q '"auth_mode"' && echo "CHATGPT" || (test -n "$OPENAI_API_KEY" && echo "API" || echo "NONE")`,
      15000
    );
  } catch {
    authCheck = 'NONE';
  }

  if (authCheck.trim() === 'NONE') {
    return {
      error: 'Codex on remote requires authentication. SSH into the machine and either:\n\n' +
             'Option 1: Login with ChatGPT (recommended):\n' +
             '   Run: codex auth\n\n' +
             'Option 2: Set OPENAI_API_KEY environment variable:\n' +
             '   export OPENAI_API_KEY=your-key-here'
    };
  }

  const cmd = `${buildRemoteCdCommand(workDir)} && printf %s ${shellQuote(lastUserMsg.content)} | ${buildCodexExecShellCommand(agent, { stdinPrompt: true })} 2>&1`;

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

async function streamCodexSSH(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const workDir = agent.workDir || '~';

  // Check for authentication first
  let authCheck = '';
  try {
    authCheck = await runSSHCommand(agent,
      `test -f ~/.codex/auth.json && cat ~/.codex/auth.json | grep -q '"auth_mode"' && echo "CHATGPT" || (test -n "$OPENAI_API_KEY" && echo "API" || echo "NONE")`,
      15000
    );
  } catch {
    authCheck = 'NONE';
  }

  if (authCheck.trim() === 'NONE') {
    event.sender.send('agent:stream-error', requestId,
      'Codex on remote requires authentication. SSH into the machine and either:\n\n' +
      'Option 1: Login with ChatGPT (recommended):\n' +
      '   Run: codex auth\n\n' +
      'Option 2: Set OPENAI_API_KEY environment variable:\n' +
      '   export OPENAI_API_KEY=your-key-here'
    );
    return;
  }

  // Feed the prompt through stdin so arbitrary user text cannot break the
  // remote shell command and Codex gets the same non-interactive mode locally.
  const cmd = `${buildRemoteCdCommand(workDir)} && printf %s ${shellQuote(lastUserMsg.content)} | ${buildCodexExecShellCommand(agent, { stdinPrompt: true })}`;

  try {
    const output = await streamSSHCommand(agent, cmd, event, requestId, 600000);
    // streamSSHCommand handles sending chunks and done event
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('authentication')) {
      event.sender.send('agent:stream-error', requestId, 'Invalid API key on remote. Check OPENAI_API_KEY.');
    } else if (msg.includes('429')) {
      event.sender.send('agent:stream-error', requestId, 'Rate limit exceeded. Please try again later.');
    } else {
      event.sender.send('agent:stream-error', requestId, msg);
    }
  }
}

async function pingCodexSSH(agent) {
  try {
    const output = await runSSHCommand(agent, 'codex --version 2>&1', 15000);

    // Check auth status
    let authStatus = '';
    try {
      const authCheck = await runSSHCommand(agent,
        `test -f ~/.codex/auth.json && echo "ChatGPT auth" || (test -n "$OPENAI_API_KEY" && echo "API key" || echo "No auth")`,
        15000
      );
      authStatus = authCheck.trim();
    } catch {
      authStatus = 'Unknown';
    }

    return {
      online: true,
      info: `${output.trim()} (${authStatus})`
    };
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
    // Use the SDK's supportedCommands() method to get ALL available commands
    discoverCmd: async (agent) => ({ sdkCommands: true, agent }),
    execCmd: (agent, slashCmd, arg) => ({ sdk: true, prompt: `${slashCmd}${arg ? ' ' + arg : ''}`, cwd: agent.workDir || process.env.HOME }),
    parseHelp: (output) => {
      // This is now only used as a fallback if supportedCommands() fails
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

      // Always ensure /skills is available for Claude Code
      if (!cmds.find(c => c.name === '/skills')) {
        cmds.push({ name: '/skills', desc: 'Manage local workflow skills' });
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
    execCmd: (agent, slashCmd, arg) => {
      if (slashCmd === '/plan') return { codexPlan: true, agent, arg };
      return { local: true, command: `${agent.codexPath || 'codex'} ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir };
    },
    staticCmds: [{ name: '/plan', desc: 'Ask Codex for an implementation plan before editing' }],
    parseHelp: parseCLIHelp,
  },
  'codex-ssh': {
    discoverCmd: (agent) => {
      const workDir = agent.workDir || '~';
      return { ssh: true, agent, command: `${buildRemoteCdCommand(workDir)} && codex --help 2>&1` };
    },
    execCmd: (agent, slashCmd, arg) => {
      const workDir = agent.workDir || '~';
      if (slashCmd === '/plan') return { codexPlan: true, agent, arg };
      return { ssh: true, agent, command: `${buildRemoteCdCommand(workDir)} && codex ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` };
    },
    staticCmds: [{ name: '/plan', desc: 'Ask Codex for an implementation plan before editing' }],
    parseHelp: parseCLIHelp,
  },
  'claude-code-ssh': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'claude --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => {
      const workDir = agent.workDir || '~';
      return { ssh: true, agent, command: `cd ${workDir} && claude ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` };
    },
    parseHelp: (output) => {
      // Parse Claude Code help output
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
      // Add common Claude Code commands if not found
      if (cmds.length === 0) {
        cmds.push(
          { name: '/help', desc: 'Show available commands' },
          { name: '/status', desc: 'Show session status' },
          { name: '/clear', desc: 'Clear conversation' },
          { name: '/skills', desc: 'Manage local workflow skills' }
        );
      }

      // Always ensure /skills is available even if not in help output
      if (!cmds.find(c => c.name === '/skills')) {
        cmds.push({ name: '/skills', desc: 'Manage local workflow skills' });
      }
      return cmds;
    },
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
      const spec = await config.discoverCmd(agent);
      let output = '';

      if (spec.sdkCommands) {
        // Use the Claude Code SDK query().supportedCommands() to get available commands
        try {
          const { query: sdkQuery } = await getClaudeSDK();
          const opts = buildClaudeSDKOptions(spec.agent || agent);
          const q = sdkQuery({ prompt: '', options: opts });
          const slashCommands = await q.supportedCommands();
          q.return(); // clean up the generator

          // Convert SDK format to our format (SDK returns names without leading /)
          const sdkCommands = slashCommands.map(cmd => {
            const name = cmd.name.startsWith('/') ? cmd.name.toLowerCase() : `/${cmd.name.toLowerCase()}`;
            return {
              name,
              desc: cmd.description + (cmd.argumentHint ? ` (${cmd.argumentHint})` : '')
            };
          }).filter(cmd => !LOCAL_COMMANDS[cmd.name]);

          commands = commands.concat(sdkCommands);

          // Add well-known Claude Code commands not reported by supportedCommands()
          const existingNames = new Set(commands.map(c => c.name));
          const builtinCommands = [
            { name: '/model', desc: 'Switch AI model (e.g. /model sonnet)' },
            { name: '/fast', desc: 'Toggle fast output mode' },
            { name: '/help', desc: 'Show available commands' },
            { name: '/permissions', desc: 'View or update permissions' },
            { name: '/memory', desc: 'View or manage memory files' },
            { name: '/config', desc: 'Open or edit configuration' },
            { name: '/doctor', desc: 'Check environment and diagnose issues' },
            { name: '/login', desc: 'Sign in to your account' },
            { name: '/logout', desc: 'Sign out of your account' },
            { name: '/bug', desc: 'Report a bug' },
            { name: '/vim', desc: 'Toggle vim keybindings' },
          ];
          for (const cmd of builtinCommands) {
            if (!existingNames.has(cmd.name)) {
              commands.push(cmd);
            }
          }

          // Cache and return early since we got commands directly from SDK
          discoveredCommandsCache.set(cacheKey, { commands, timestamp: Date.now() });
          return commands;
        } catch (e) {
          console.error('Failed to get commands via supportedCommands():', e.message);
          // Fall back to the /help method below
        }
      }

      if (spec.sdk) {
        // Fallback: Use the Claude Code SDK to run /help command
        try {
          const { query } = await getClaudeSDK();
          const opts = buildClaudeSDKOptions(agent);
          for await (const msg of query({ prompt: spec.prompt || '/help', options: opts })) {
            if (msg.type === 'result' && msg.result) output += msg.result;
            else if (msg.type === 'assistant' && msg.message?.content) {
              for (const b of msg.message.content) {
                if (b.type === 'text') output += b.text || '';
              }
            }
          }
        } catch (e) {
          console.error('SDK slash command failed:', e.message);
        }
      } else if (spec.cli) {
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

    // Codex does not expose plan mode as a CLI subcommand. Treat /plan as a
    // planning prompt so the slash palette can offer the workflow without
    // running `codex plan`.
    if (spec.codexPlan) {
      if (!arg) {
        return { content: 'Usage: /plan <what you want Codex to plan>' };
      }

      const planPrompt = [
        'Plan mode: create a concise implementation plan for the request below.',
        'Do not edit files or run commands that change state. Ask clarifying questions if the request is underspecified.',
        '',
        arg,
      ].join('\n');

      if (provider === 'codex') {
        return await chatCodexLocal(agent, [{ role: 'user', content: planPrompt }]);
      }
      if (provider === 'codex-ssh') {
        return await chatCodexSSH(agent, [{ role: 'user', content: planPrompt }]);
      }
    }

    // SDK command (Claude Code slash commands via the SDK)
    if (spec.sdk) {
      const { query } = await getClaudeSDK();
      const opts = buildClaudeSDKOptions(agent);
      let content = '';
      let sessionId = null;
      for await (const msg of query({ prompt: spec.prompt, options: opts })) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
        }
        if (msg.type === 'result' && msg.result) content = msg.result;
        else if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b.type === 'text') content += b.text || '';
          }
        }
      }
      // Trigger discovery after running a command
      discoverCommands(agent).catch(() => {});
      return { content: content.trim(), sessionId };
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

    // Legacy CLI command (non-Claude-Code providers)
    if (spec.cli) {
      const output = await runLocalCommand(spec.cli, spec.args, { cwd: spec.cwd || process.env.HOME, timeout: 30000 });
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
      // Providers without streaming: run non-streaming chat and emit result as a single chunk
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

// Handle permission responses from the renderer
// Works with both SDK (resolvePermission callback) and legacy CLI (stdin write)
ipcMain.on('agent:permission-response', (_event, requestId, toolUseId, decision) => {
  const handle = activeClaudeProcs.get(requestId);
  if (!handle) return;

  // SDK path — resolve the pending permission promise
  if (handle.resolvePermission) {
    handle.resolvePermission(toolUseId, decision);
    return;
  }

  // Legacy CLI path (for non-Claude-Code providers that may still use stdin)
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
    } else if (agent.provider === 'claude-code-ssh') {
      return await pingClaudeCodeSSH(agent);
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
