const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  nativeTheme.themeSource = 'dark';
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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
              event.sender.send('agent:stream-done', requestId);
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
      res.on('end', () => { event.sender.send('agent:stream-done', requestId); resolve(); });
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
      event.sender.send('agent:stream-done', requestId);
      resolve(fullOutput);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      event.sender.send('agent:stream-done', requestId);
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
    event.sender.send('agent:stream-done', requestId);
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractOpenClawResponse(errMsg);
    if (content && !content.includes('Permission denied') && !content.includes('Connection refused')) {
      event.sender.send('agent:stream-chunk', requestId, content);
      event.sender.send('agent:stream-done', requestId);
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

function runLocalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      cwd: options.cwd || process.env.HOME,
      shell: true,
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

  // Build args for one-shot print mode
  const args = ['-p', escapedMsg, '--no-input'];
  if (agent.model) args.push('--model', agent.model);
  if (agent.maxTokens) args.push('--max-tokens', String(agent.maxTokens));
  if (agent.claudeArgs) {
    // Allow custom args like --allowedTools, --permission-mode, etc.
    args.push(...agent.claudeArgs.split(/\s+/).filter(Boolean));
  }

  // If a session ID is stored, continue it
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
    const content = extractClaudeCodeResponse(output);
    return { content };
  } catch (err) {
    return { error: err.message };
  }
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

// ── IPC Handlers ──

ipcMain.handle('agent:chat', async (_event, agent, messages) => {
  try {
    if (agent.provider === 'anthropic') return await chatAnthropic(agent, messages);
    if (agent.provider === 'openclaw') return await chatOpenClaw(agent, messages);
    if (agent.provider === 'hermes') return await chatHermes(agent, messages);
    if (agent.provider === 'claude-code') return await chatClaudeCode(agent, messages);
    return await chatOpenAI(agent, messages);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('agent:chat-stream', async (event, requestId, agent, messages) => {
  try {
    if (agent.provider === 'anthropic') await streamAnthropic(event, requestId, agent, messages);
    else if (agent.provider === 'openclaw') await streamOpenClaw(event, requestId, agent, messages);
    else await streamOpenAI(event, requestId, agent, messages);
  } catch (err) {
    event.sender.send('agent:stream-error', requestId, err.message);
  }
});

ipcMain.handle('agent:ping', async (_event, agent) => {
  try {
    if (agent.provider === 'anthropic') {
      const res = await makeRequest('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': agent.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, JSON.stringify({ model: agent.model || 'claude-sonnet-4-20250514', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
      return { online: res.status === 200 };
    } else if (agent.provider === 'openclaw') {
      return await pingOpenClaw(agent);
    } else if (agent.provider === 'hermes') {
      return await pingHermes(agent);
    } else if (agent.provider === 'claude-code') {
      return await pingClaudeCode(agent);
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
  return { content: data.choices?.[0]?.message?.content || '' };
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

// ── Provider: Anthropic ──

async function chatAnthropic(agent, messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');
  const body = {
    model: agent.model || 'claude-sonnet-4-20250514',
    max_tokens: agent.maxTokens || 16384,
    messages: chatMsgs,
  };
  if (systemMsg) body.system = systemMsg.content;
  const res = await makeRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': agent.apiKey,
      'anthropic-version': '2023-06-01',
    },
  }, JSON.stringify(body));
  const data = JSON.parse(res.body);
  if (res.status !== 200) return { error: data.error?.message || res.body };
  return { content: data.content?.[0]?.text || '' };
}

async function streamAnthropic(event, requestId, agent, messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');
  const reqBody = {
    model: agent.model || 'claude-sonnet-4-20250514',
    max_tokens: agent.maxTokens || 16384,
    messages: chatMsgs,
    stream: true,
  };
  if (systemMsg) reqBody.system = systemMsg.content;

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': agent.apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content_block_delta' && data.delta?.text) {
                event.sender.send('agent:stream-chunk', requestId, data.delta.text);
              }
              if (data.type === 'message_stop') {
                event.sender.send('agent:stream-done', requestId);
              }
            } catch (e) { /* skip */ }
          }
        }
      });
      res.on('end', () => { event.sender.send('agent:stream-done', requestId); resolve(); });
    });
    req.on('error', (err) => { event.sender.send('agent:stream-error', requestId, err.message); reject(err); });
    req.write(JSON.stringify(reqBody));
    req.end();
  });
}
