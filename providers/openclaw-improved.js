const { spawn } = require('child_process');
const { makeRequest, makeStreamRequest } = require('../lib/http');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand } = require('../lib/local');

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_PORT = 18789;
const CHAT_TIMEOUT = 300000;   // 5 min — agent turns can be slow
const PING_TIMEOUT = 15000;    // 15s for health checks

// ── Shared Helpers ─────────────────────────────────────────────────────────

function isRemote(agent) {
  return !!agent.sshHost;
}

function getModel(agent) {
  const agentId = agent.openclawAgent;
  return agentId ? `openclaw/${agentId}` : 'openclaw/default';
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

function buildRequestBody(agent, messages) {
  return JSON.stringify({
    model: getModel(agent),
    messages: transformMessages(messages),
  });
}

/**
 * Parse output from the openclaw agent CLI (--json format).
 * Handles the "payloads" JSON format, standard OpenAI JSON, and raw text.
 */
function parseOpenClawOutput(output) {
  if (!output) return { error: 'Empty response' };

  // Try payloads JSON format (CLI --json output)
  try {
    const jsonMatch = output.match(/\{[\s\S]*"payloads"[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      const texts = (data.payloads || []).map(p => p.text).filter(Boolean);
      if (texts.length > 0) return { content: texts.join('\n\n') };
    }
  } catch (e) { /* fall through */ }

  // Try OpenAI chat completion JSON
  try {
    const data = JSON.parse(output.trim());
    if (data.error?.message) return { error: data.error.message };
    const content = data.choices?.[0]?.message?.content;
    if (content) return { content, thinking: data.choices[0].message.reasoning_content || null };
  } catch (e) { /* fall through */ }

  // Strip gateway noise, return remaining text
  const filtered = output.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return false;
    if (/^(gateway|source:|config:|bind:|warning:|debug:|info:|\[.*\]$)/i.test(t)) return false;
    return true;
  }).join('\n').trim();

  return filtered.length > 5 ? { content: filtered } : { error: 'No content in response' };
}

// ── SSH execution with stdin piping ────────────────────────────────────────

/**
 * Run a command on the remote machine via SSH, optionally piping data to stdin.
 * This is used for curl requests where the JSON body goes through stdin
 * to avoid all shell escaping issues.
 */
function sshExec(agent, command, stdinData, timeout) {
  return new Promise((resolve, reject) => {
    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-p', String(agent.sshPort || 22),
    ];
    if (agent.sshKey) sshArgs.push('-i', agent.sshKey);
    sshArgs.push(`${agent.sshUser || 'root'}@${agent.sshHost}`);
    sshArgs.push(command);

    const proc = spawn('ssh', sshArgs);

    if (stdinData) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('Warning:') && !text.includes('Permanently added')) {
        stderr += text;
      }
    });

    let timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Request timeout'));
    }, timeout);

    // Reset timeout when data arrives (agent can have long think pauses)
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { proc.kill(); reject(new Error('Request timeout')); }, timeout);
    };
    proc.stdout.on('data', resetTimer);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout.trim() && (code !== 0 || stderr.trim())) {
        reject(new Error(stderr.trim() || `SSH exit code ${code}`));
        return;
      }
      resolve(stdout);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── curl command builder for remote HTTP API ───────────────────────────────

function buildCurlCmd(agent, path, method, hasBody) {
  const port = agent.gatewayPort || DEFAULT_GATEWAY_PORT;
  let cmd = `curl -s -X ${method} http://127.0.0.1:${port}${path}`;
  cmd += ` -H ${escapeForShell('Content-Type: application/json')}`;
  if (agent.apiKey) {
    cmd += ` -H ${escapeForShell('Authorization: Bearer ' + agent.apiKey)}`;
  }
  if (agent.model) {
    cmd += ` -H ${escapeForShell('x-openclaw-model: ' + agent.model)}`;
  }
  if (hasBody) cmd += ' -d @-';
  return cmd;
}

// ── Remote chat: HTTP API via SSH+curl, fallback to CLI ────────────────────

async function remoteChat(agent, messages) {
  // Try HTTP API first (clean JSON, full conversation history)
  try {
    const curlCmd = buildCurlCmd(agent, '/v1/chat/completions', 'POST', true);
    const body = buildRequestBody(agent, messages);
    const output = await sshExec(agent, curlCmd, body, CHAT_TIMEOUT);
    const data = JSON.parse(output.trim());

    if (data.error) throw new Error(data.error.message || 'Gateway error');

    const choice = data.choices?.[0]?.message;
    if (choice?.content) {
      return { content: choice.content, thinking: choice.reasoning_content || null };
    }
    // Got a valid response but no content — maybe empty reply
    if (data.choices) return { content: '' };
  } catch (httpErr) {
    // HTTP API not available or returned junk — fall through to CLI
  }

  // Fallback: CLI via existing runSSHCommand
  return remoteChatCLI(agent, messages);
}

async function remoteChatCLI(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const agentId = agent.openclawAgent || 'main';
  const cmd = `openclaw agent --agent ${escapeForShell(agentId)} --message ${escapeForShell(lastUserMsg.content)} --json`;

  try {
    const output = await runSSHCommand(agent, cmd, CHAT_TIMEOUT);
    return parseOpenClawOutput(output);
  } catch (err) {
    // runSSHCommand sometimes throws with useful output in the error message
    const parsed = parseOpenClawOutput(err.message || '');
    if (parsed.content) return parsed;
    return { error: err.message };
  }
}

// ── Local chat: HTTP API, fallback to CLI ──────────────────────────────────

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

async function localChat(agent, messages) {
  // Try HTTP API first
  try {
    const url = localUrl(agent, '/v1/chat/completions');
    const headers = localHeaders(agent);
    const body = buildRequestBody(agent, messages);
    const res = await makeRequest(url, { method: 'POST', headers, timeout: CHAT_TIMEOUT }, body);
    const data = JSON.parse(res.body);

    if (res.status !== 200) throw new Error(data.error?.message || `Gateway error (${res.status})`);

    const choice = data.choices?.[0]?.message;
    return { content: choice?.content || '', thinking: choice?.reasoning_content || null };
  } catch (httpErr) {
    if (httpErr.code !== 'ECONNREFUSED') throw httpErr;
    // Gateway not running, fall through to CLI
  }

  // Fallback: CLI
  return localChatCLI(agent, messages);
}

async function localChatCLI(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const agentId = agent.openclawAgent || 'main';
  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''");
  const workDir = agent.workDir || process.env.HOME;
  const cmd = `openclaw agent --agent '${agentId}' --message '${escapedMsg}' --json`;

  try {
    const output = await runLocalCommand('bash', ['-l', '-c', cmd], { cwd: workDir, timeout: CHAT_TIMEOUT });
    return parseOpenClawOutput(output);
  } catch (err) {
    const parsed = parseOpenClawOutput(err.message || '');
    if (parsed.content) return parsed;
    return { error: err.message };
  }
}

// ── Main API Functions ─────────────────────────────────────────────────────

async function chatOpenClaw(agent, messages) {
  try {
    return isRemote(agent) ? await remoteChat(agent, messages) : await localChat(agent, messages);
  } catch (err) {
    return { error: `OpenClaw: ${err.message}` };
  }
}

async function streamOpenClaw(event, requestId, agent, messages) {
  // Local with gateway running: real SSE streaming
  if (!isRemote(agent)) {
    try {
      const url = localUrl(agent, '/v1/chat/completions');
      const headers = localHeaders(agent);
      const body = JSON.stringify({
        model: getModel(agent),
        messages: transformMessages(messages),
        stream: true,
      });
      await makeStreamRequest(url, { method: 'POST', headers, timeout: CHAT_TIMEOUT }, body, event, requestId);
      return;
    } catch (err) {
      // If not ECONNREFUSED, it's a real error
      if (err.code !== 'ECONNREFUSED') {
        event.sender.send('agent:stream-error', requestId, `OpenClaw: ${err.message}`);
        return;
      }
      // Gateway not running, fall through to non-streaming
    }
  }

  // Remote or local-without-gateway: get full response, emit as chunk
  try {
    const result = await chatOpenClaw(agent, messages);
    if (result.error) {
      event.sender.send('agent:stream-error', requestId, result.error);
    } else {
      if (result.thinking) event.sender.send('agent:stream-thinking', requestId, result.thinking);
      if (result.content) event.sender.send('agent:stream-chunk', requestId, result.content);
      event.sender.send('agent:stream-done', requestId, {});
    }
  } catch (err) {
    event.sender.send('agent:stream-error', requestId, `OpenClaw: ${err.message}`);
  }
}

async function pingOpenClaw(agent) {
  if (isRemote(agent)) {
    // Try HTTP health check via curl
    try {
      const curlCmd = buildCurlCmd(agent, '/v1/models', 'GET', false);
      const output = await sshExec(agent, curlCmd, null, PING_TIMEOUT);
      if (output.trim()) return { online: true, info: 'Gateway connected' };
    } catch (e) { /* fall through to CLI */ }

    // Fallback: CLI health check
    try {
      const output = await runSSHCommand(agent, 'openclaw health --json 2>/dev/null || openclaw --version 2>&1', PING_TIMEOUT);
      return { online: true, info: output.trim().slice(0, 100) };
    } catch (err) {
      return { online: false, error: err.message };
    }
  }

  // Local: try HTTP
  try {
    const url = localUrl(agent, '/v1/models');
    const headers = {};
    if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
    const res = await makeRequest(url, { method: 'GET', headers, timeout: PING_TIMEOUT });
    if (res.status === 200) return { online: true, info: 'Gateway connected' };
    if (res.status === 401) return { online: false, error: 'Auth failed — check gateway token' };
    return { online: false, error: `Gateway returned HTTP ${res.status}` };
  } catch (httpErr) {
    if (httpErr.code !== 'ECONNREFUSED') return { online: false, error: httpErr.message };
  }

  // Local fallback: CLI
  try {
    const output = await runLocalCommand('bash', ['-l', '-c', 'openclaw health --json 2>/dev/null || openclaw --version 2>&1'], { timeout: 10000 });
    return { online: true, info: output.trim().slice(0, 100) };
  } catch (err) {
    return { online: false, error: err.message };
  }
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
