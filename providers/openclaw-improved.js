const { spawn } = require('child_process');
const { makeRequest, makeStreamRequest } = require('../lib/http');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand } = require('../lib/local');

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_PORT = 18789;
const CHAT_TIMEOUT = 300000;   // 5 min — agent turns can be slow
const PING_TIMEOUT = 15000;    // 15s for health checks

// Gateway noise lines that appear on stdout before the actual response.
// These must be filtered so only the agent's reply reaches the UI.
const NOISE_PATTERNS = [
  /^gateway connect failed/i,
  /^Gateway agent failed/i,
  /^Gateway target:/i,
  /^Source:/i,
  /^Config:/i,
  /^Bind:/i,
];

function isNoiseLine(line) {
  const t = line.trim();
  return !t || NOISE_PATTERNS.some(p => p.test(t));
}

// ── Shared Helpers ─────────────────────────────────────────────────────────

function isRemote(agent) {
  return !!agent.sshHost;
}

function escapeForShell(str) {
  if (!str) return "''";
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function transformMessages(messages) {
  return messages.map(msg => {
    if (msg.images?.length > 0) {
      const content = [{ type: 'text', text: msg.content || '' }];
      for (const img of msg.images) {
        if (img.base64) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` },
          });
        } else if (img.url) {
          content.push({ type: 'image_url', image_url: { url: img.url } });
        }
      }
      return { role: msg.role, content };
    }
    return { role: msg.role, content: msg.content };
  });
}

/**
 * Generate a session ID that mimics the OpenClaw TUI format.
 * Persisted via stream-done meta so the UI reuses it across messages.
 */
function getOrCreateSessionId(agent) {
  if (agent.sessionId) return agent.sessionId;
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return `agent-hub-${uuid}`;
}

// ── CLI command builders ───────────────────────────────────────────────────

/**
 * Build CLI command for LOCAL execution (single shell layer).
 * Single-quote escaping works directly with bash -l -c.
 */
function buildLocalCmd(agentId, message, { json = false, sessionId = null } = {}) {
  let cmd = `openclaw agent --agent ${escapeForShell(agentId)} --message ${escapeForShell(message)}`;
  if (sessionId) cmd += ` --session-id ${escapeForShell(sessionId)}`;
  if (json) cmd += ' --json';
  return cmd;
}

/**
 * Build CLI command for SSH execution (double shell layer).
 * The message is base64-encoded to avoid escaping through two shells.
 * Decoded on the remote side via $(printf %s <b64> | base64 -d) inside
 * double quotes — command substitution output is not re-interpreted.
 */
function buildSSHCmd(agentId, message, { json = false, sessionId = null } = {}) {
  const b64 = Buffer.from(message).toString('base64');
  let cmd = `openclaw agent --agent "${agentId}" --message "$(printf %s ${b64} | base64 -d)"`;
  if (sessionId) cmd += ` --session-id "${sessionId}"`;
  if (json) cmd += ' --json';
  return cmd;
}

// ── SSH helpers ────────────────────────────────────────────────────────────

function buildSSHArgs(agent) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-p', String(agent.sshPort || 22),
  ];
  if (agent.sshKey) args.push('-i', agent.sshKey);
  args.push(`${agent.sshUser || 'root'}@${agent.sshHost}`);
  return args;
}

// ── JSON response parsing ──────────────────────────────────────────────────

/**
 * Parse CLI --json output. Strips gateway noise, extracts payloads and meta.
 * Returns { content, thinking?, sessionId?, model?, provider? }
 */
function parseJsonOutput(raw) {
  if (!raw) return { error: 'Empty response' };

  // Strip noise lines before the JSON
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) {
    // No JSON found — try to extract plain text
    return parsePlainOutput(raw);
  }

  const jsonStr = raw.slice(jsonStart);
  try {
    const data = JSON.parse(jsonStr);

    const texts = (data.payloads || []).map(p => p.text).filter(Boolean);
    const content = texts.join('\n\n');
    const meta = data.meta || {};
    const agentMeta = meta.agentMeta || {};
    const report = meta.systemPromptReport || {};

    return {
      content: content || '',
      sessionId: report.sessionId || null,
      model: agentMeta.model || null,
      provider: agentMeta.provider || null,
    };
  } catch (e) {
    return parsePlainOutput(raw);
  }
}

/**
 * Parse plain text output (no --json). Strips gateway noise lines.
 */
function parsePlainOutput(raw) {
  if (!raw) return { error: 'Empty response' };

  const lines = raw.split('\n');
  const content = [];
  let pastNoise = false;

  for (const line of lines) {
    if (!pastNoise) {
      if (isNoiseLine(line)) continue;
      pastNoise = true;
    }
    content.push(line);
  }

  const text = content.join('\n').trim();
  return text ? { content: text } : { error: 'No content in response' };
}

// ── Real-time CLI streaming ────────────────────────────────────────────────

/**
 * Core streaming handler. Spawns a process running the openclaw CLI
 * (without --json) and streams filtered stdout to the UI in real-time.
 *
 * Gateway noise lines at the start of output are silently dropped.
 * Once the first real content line appears, all subsequent output
 * streams through unmodified — exactly like watching it in a terminal.
 */
function streamFromProcess(proc, event, requestId, sessionId, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let sawContent = false;
    let pastNoise = false;
    let lineBuffer = '';
    let stderrBuf = '';

    function sendChunk(text) {
      if (text) {
        sawContent = true;
        event.sender.send('agent:stream-chunk', requestId, text);
      }
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();

      // Once we're past the noise section, stream everything through raw
      if (pastNoise) {
        sendChunk(text);
        return;
      }

      // Still in potential noise section — filter line by line
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep incomplete last line in buffer

      for (let i = 0; i < lines.length; i++) {
        if (isNoiseLine(lines[i])) continue;

        // First real content line — we're past the noise
        pastNoise = true;
        // Send this line and all remaining buffered lines
        const remaining = lines.slice(i).join('\n');
        sendChunk(lineBuffer ? remaining + '\n' + lineBuffer : remaining);
        lineBuffer = '';
        return;
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('Warning:') && !text.includes('Permanently added')) {
        stderrBuf += text;
      }
    });

    let timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'Command timeout');
      resolve();
    }, timeout);

    // Reset timeout on any stdout data — agent can pause while thinking
    proc.stdout.on('data', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        event.sender.send('agent:stream-error', requestId, 'Command timeout');
        resolve();
      }, timeout);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Flush any remaining buffer (filter noise if we never got past it)
      if (lineBuffer.trim()) {
        if (pastNoise || !isNoiseLine(lineBuffer)) {
          sendChunk(lineBuffer);
        }
      }

      if (code !== 0 && !sawContent) {
        const errMsg = stderrBuf.trim() || `openclaw exited with code ${code}`;
        event.sender.send('agent:stream-error', requestId, errMsg);
      } else {
        event.sender.send('agent:stream-done', requestId, { sessionId });
      }
      resolve();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      resolve();
    });
  });
}

// ── Remote: SSH execution ──────────────────────────────────────────────────

async function remoteStreamCli(event, requestId, agent, message, sessionId) {
  const agentId = agent.openclawAgent || 'main';
  const cmd = buildSSHCmd(agentId, message, { sessionId });

  const sshArgs = [...buildSSHArgs(agent), `bash -l -c ${JSON.stringify(cmd)}`];
  const proc = spawn('ssh', sshArgs);

  await streamFromProcess(proc, event, requestId, sessionId, CHAT_TIMEOUT);
}

async function remoteChatCli(agent, message, sessionId) {
  const agentId = agent.openclawAgent || 'main';
  const cmd = buildSSHCmd(agentId, message, { json: true, sessionId });

  try {
    const output = await runSSHCommand(agent, cmd, CHAT_TIMEOUT);
    return parseJsonOutput(output);
  } catch (err) {
    // runSSHCommand sometimes throws with useful output in the error
    const parsed = parseJsonOutput(err.message || '');
    if (parsed.content) return parsed;
    return { error: err.message };
  }
}

async function remotePing(agent) {
  try {
    const output = await runSSHCommand(agent, 'openclaw health --json 2>/dev/null || openclaw --version 2>&1', PING_TIMEOUT);
    const trimmed = output.trim();
    // Try to extract version from output
    const versionMatch = trimmed.match(/OpenClaw\s+[\d.]+/);
    return { online: true, info: versionMatch ? versionMatch[0] : 'OpenClaw running' };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Local: direct execution, HTTP API where available ──────────────────────

function localUrl(agent, path) {
  const port = agent.gatewayPort || DEFAULT_GATEWAY_PORT;
  return `http://127.0.0.1:${port}${path}`;
}

function localHeaders(agent) {
  const headers = { 'Content-Type': 'application/json' };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  if (agent.model) headers['x-openclaw-model'] = agent.model;
  return headers;
}

async function localStreamCli(event, requestId, agent, message, sessionId) {
  const agentId = agent.openclawAgent || 'main';
  const workDir = agent.workDir || process.env.HOME;
  const cmd = buildLocalCmd(agentId, message, { sessionId });

  const proc = spawn('bash', ['-l', '-c', cmd], { cwd: workDir });

  await streamFromProcess(proc, event, requestId, sessionId, CHAT_TIMEOUT);
}

async function localChatCli(agent, message, sessionId) {
  const agentId = agent.openclawAgent || 'main';
  const workDir = agent.workDir || process.env.HOME;
  const cmd = buildLocalCmd(agentId, message, { json: true, sessionId });

  try {
    const output = await runLocalCommand('bash', ['-l', '-c', cmd], { cwd: workDir, timeout: CHAT_TIMEOUT });
    return parseJsonOutput(output);
  } catch (err) {
    const parsed = parseJsonOutput(err.message || '');
    if (parsed.content) return parsed;
    return { error: err.message };
  }
}

async function localChatHttp(agent, messages, sessionId) {
  const url = localUrl(agent, '/v1/chat/completions');
  const headers = localHeaders(agent);
  const agentId = agent.openclawAgent;
  const body = JSON.stringify({
    model: agentId ? `openclaw/${agentId}` : 'openclaw/default',
    messages: transformMessages(messages),
    user: sessionId || undefined,
  });

  const res = await makeRequest(url, { method: 'POST', headers, timeout: CHAT_TIMEOUT }, body);
  const data = JSON.parse(res.body);

  if (res.status !== 200) throw new Error(data.error?.message || `Gateway error (${res.status})`);

  const choice = data.choices?.[0]?.message;
  return {
    content: choice?.content || '',
    thinking: choice?.reasoning_content || null,
    sessionId,
  };
}

async function localPing(agent) {
  // Try HTTP first (fast if gateway is serving)
  try {
    const url = localUrl(agent, '/v1/models');
    const headers = {};
    if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
    const res = await makeRequest(url, { method: 'GET', headers, timeout: PING_TIMEOUT });
    if (res.status === 200) return { online: true, info: 'Gateway connected' };
    if (res.status === 401) return { online: false, error: 'Auth failed — check gateway token' };
  } catch (e) { /* fall through */ }

  // Fallback: CLI
  try {
    const output = await runLocalCommand('bash', ['-l', '-c', 'openclaw health --json 2>/dev/null || openclaw --version 2>&1'], { timeout: 10000 });
    const trimmed = output.trim();
    const versionMatch = trimmed.match(/OpenClaw\s+[\d.]+/);
    return { online: true, info: versionMatch ? versionMatch[0] : 'OpenClaw running' };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Main API Functions ─────────────────────────────────────────────────────

async function chatOpenClaw(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const sessionId = getOrCreateSessionId(agent);

  try {
    if (isRemote(agent)) {
      return await remoteChatCli(agent, lastUserMsg.content, sessionId);
    }

    // Local: try HTTP API first (if gateway has chatCompletions enabled)
    try {
      return await localChatHttp(agent, messages, sessionId);
    } catch (httpErr) {
      if (httpErr.code !== 'ECONNREFUSED') {
        // Got a response but not valid — could be Control UI HTML.
        // Try parsing as JSON; if it fails, fall through to CLI.
        try { JSON.parse(httpErr.message); } catch (e) { /* fall through */ }
      }
    }

    return await localChatCli(agent, lastUserMsg.content, sessionId);
  } catch (err) {
    return { error: `OpenClaw: ${err.message}` };
  }
}

async function streamOpenClaw(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const sessionId = getOrCreateSessionId(agent);

  try {
    if (isRemote(agent)) {
      await remoteStreamCli(event, requestId, agent, lastUserMsg.content, sessionId);
    } else {
      await localStreamCli(event, requestId, agent, lastUserMsg.content, sessionId);
    }
  } catch (err) {
    event.sender.send('agent:stream-error', requestId, `OpenClaw: ${err.message}`);
  }
}

async function pingOpenClaw(agent) {
  return isRemote(agent) ? remotePing(agent) : localPing(agent);
}

async function chatOpenClawLocal(agent, messages) {
  return chatOpenClaw({ ...agent, sshHost: null }, messages);
}

async function pingOpenClawLocal(agent) {
  return pingOpenClaw({ ...agent, sshHost: null });
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  chatOpenClaw,
  streamOpenClaw,
  pingOpenClaw,
  chatOpenClawLocal,
  pingOpenClawLocal,
};
