const { spawn } = require('child_process');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand, getLoginEnv } = require('../lib/local');
const { activeClaudeProcs } = require('../lib/state');

// ── SDK lazy loader ──────────────────────────────────────────────────────

let _claudeSDK = null;
async function getClaudeSDK() {
  if (!_claudeSDK) {
    try {
      _claudeSDK = await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      return null;
    }
  }
  return _claudeSDK;
}

// ── Pending tool approval tracking (SDK permission flow) ─────────────────

const pendingToolApprovals = new Map();

function waitForToolApproval(approvalId) {
  return new Promise((resolve) => {
    pendingToolApprovals.set(approvalId, resolve);
    // Timeout after 55s — deny by default
    setTimeout(() => {
      if (pendingToolApprovals.has(approvalId)) {
        pendingToolApprovals.delete(approvalId);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }
    }, 55000);
  });
}

function resolveToolApproval(approvalId, decision) {
  const resolve = pendingToolApprovals.get(approvalId);
  if (resolve) {
    pendingToolApprovals.delete(approvalId);
    resolve(decision);
  }
}

// ── Active SDK sessions ──────────────────────────────────────────────────

const activeSDKSessions = new Map();

// Clean up completed sessions older than 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSDKSessions) {
    if (session.status === 'completed' && now - session.completedAt > 30 * 60 * 1000) {
      activeSDKSessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ── SSH spawner for SDK (runs Claude Code on remote host via SSH) ────────

function buildSSHSpawner(agent) {
  const sshUser = agent.sshUser || 'root';
  const sshHost = agent.sshHost;
  const sshPort = agent.sshPort || 22;
  const sshKey = agent.sshKey || '';

  return (options) => {
    // The SDK passes the local node binary + local cli.js path as command/args,
    // which don't exist on the remote. Replace with the remote `claude` binary
    // and only keep the CLI flags (skip the local script path).
    const claudePath = agent.claudePath || 'claude';
    const cliFlags = (options.args || []).filter(a => !a.endsWith('.js') && !a.endsWith('.mjs'));
    const remoteCmd = [claudePath, ...cliFlags]
      .map(a => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');
    const workDir = agent.workDir || '~';
    const wrappedCmd = `cd ${workDir} && ${remoteCmd}`;

    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-p', String(sshPort),
    ];
    if (sshKey) sshArgs.push('-i', sshKey);
    sshArgs.push(`${sshUser}@${sshHost}`, `bash -l -c ${JSON.stringify(wrappedCmd)}`);

    const proc = spawn('ssh', sshArgs);

    // The SDK expects a SpawnedProcess interface — Node's ChildProcess satisfies it
    return proc;
  };
}

// ── Build SDK options from agent config (with optional SSH spawner) ──────

function buildSDKOptionsForSSH(agent) {
  const options = buildSDKOptions(agent);

  // Override cwd — the remote workDir is handled by the SSH spawner's cd
  options.cwd = agent.workDir || '/root';

  // Attach the custom SSH spawner so the SDK runs claude on the remote host
  options.spawnClaudeCodeProcess = buildSSHSpawner(agent);

  return options;
}

// ── SDK-based streaming chat via SSH ────────────────────────────────────

async function streamClaudeCodeSDKviaSSH(event, requestId, agent, prompt) {
  const sdk = await getClaudeSDK();
  if (!sdk) return false; // SDK not available, fall back to CLI

  const options = buildSDKOptionsForSSH(agent);
  const abortController = new AbortController();
  options.abortController = abortController;

  // Permission handler — sends IPC to frontend, waits for response
  if (options.permissionMode !== 'bypassPermissions') {
    options.canUseTool = async (toolName, toolInput, permOpts) => {
      const approvalId = permOpts.toolUseID || `${requestId}-${Date.now()}`;

      event.sender.send('agent:permission-request', requestId, {
        toolUseId: approvalId,
        tool: toolName,
        input: toolInput,
        title: permOpts.title,
        description: permOpts.description,
        displayName: permOpts.displayName,
        timestamp: Date.now(),
      });

      return waitForToolApproval(approvalId);
    };
  }

  // Track the session
  const session = {
    status: 'running',
    startTime: Date.now(),
    abort: () => abortController.abort(),
    resolveToolApproval,
  };
  activeSDKSessions.set(requestId, session);
  activeClaudeProcs.set(requestId, {
    abort: () => abortController.abort(),
    sdkSession: true,
    resolveToolApproval,
  });

  let sessionId = null;
  const seenBlocks = new Set();

  try {
    const queryInstance = sdk.query({ prompt, options });

    for await (const message of queryInstance) {
      if (!message || !message.type) continue;

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        continue;
      }

      if (message.type === 'stream_event' && message.event) {
        const evt = message.event;
        if (evt.type === 'content_block_delta') {
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            event.sender.send('agent:stream-chunk', requestId, evt.delta.text);
          }
          if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
            event.sender.send('agent:stream-thinking', requestId, evt.delta.thinking);
          }
        }
        if (evt.type === 'content_block_start' && evt.index != null) {
          seenBlocks.add(evt.index);
        }
        continue;
      }

      if (message.type === 'assistant' && message.message?.content) {
        for (let i = 0; i < message.message.content.length; i++) {
          const block = message.message.content[i];
          if (block.type === 'tool_use') {
            event.sender.send('agent:stream-tool-use', requestId, {
              id: block.id,
              tool: block.name,
              input: block.input,
            });
          }
          if (!seenBlocks.has(i)) {
            if (block.type === 'text' && block.text) {
              event.sender.send('agent:stream-chunk', requestId, block.text);
            }
            if (block.type === 'thinking' && block.thinking) {
              event.sender.send('agent:stream-thinking', requestId, block.thinking);
            }
          }
        }
        seenBlocks.clear();
        continue;
      }

      if (message.type === 'result') {
        sessionId = message.session_id || sessionId;
        continue;
      }
    }

    session.status = 'completed';
    session.completedAt = Date.now();
    event.sender.send('agent:stream-done', requestId, { sessionId });
    return true;
  } catch (err) {
    session.status = 'completed';
    session.completedAt = Date.now();
    const msg = err.message || '';
    if (err.name === 'AbortError' || msg.includes('aborted')) {
      event.sender.send('agent:stream-done', requestId, { sessionId });
    } else if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
      event.sender.send('agent:stream-error', requestId, 'Claude Code on remote is not authenticated. SSH into the machine and run: claude auth login');
    } else {
      event.sender.send('agent:stream-error', requestId, msg);
    }
    return true;
  } finally {
    activeClaudeProcs.delete(requestId);
  }
}

// ── SDK-based non-streaming chat via SSH ─────────────────────────────────

async function chatClaudeCodeSDKviaSSH(agent, prompt) {
  const sdk = await getClaudeSDK();
  if (!sdk) return null; // SDK not available, fall back to CLI

  const options = buildSDKOptionsForSSH(agent);
  const abortController = new AbortController();
  options.abortController = abortController;

  // For non-streaming, auto-allow tools (no UI to approve)
  if (options.permissionMode !== 'bypassPermissions') {
    options.permissionMode = 'acceptEdits';
  }

  let sessionId = null;
  let resultText = '';

  try {
    const queryInstance = sdk.query({ prompt, options });

    for await (const message of queryInstance) {
      if (!message || !message.type) continue;

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        continue;
      }

      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            resultText += block.text;
          }
        }
        continue;
      }

      if (message.type === 'result') {
        sessionId = message.session_id || sessionId;
        if (message.result) resultText = message.result;
        continue;
      }
    }

    return { content: resultText, sessionId };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
      return { error: 'Claude Code on remote is not authenticated. SSH into the machine and run: claude auth login' };
    }
    return { error: msg };
  }
}

// ── Build SDK options from agent config ──────────────────────────────────

function buildSDKOptions(agent) {
  const options = {
    cwd: agent.workDir || process.env.HOME,
    includePartialMessages: true,
    tools: { type: 'preset', preset: 'claude_code' },
  };

  if (agent.model) options.model = agent.model;
  if (agent.systemPrompt) options.systemPrompt = agent.systemPrompt;

  // Permission mode
  const perm = agent.permissionMode || 'default';
  if (perm === 'bypassPermissions') {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
  } else {
    options.permissionMode = perm;
  }

  // Allowed tools
  if (agent.allowedTools) {
    options.allowedTools = agent.allowedTools.split(/[,\s]+/).filter(Boolean);
  }

  // Session resume
  if (agent.sessionId) {
    options.resume = agent.sessionId;
  } else if (agent.continueSession) {
    options.continue = true;
  }

  // Custom spawner to ensure the login shell PATH is used
  // (Electron launched from Finder/Dock won't have ~/.local/bin in PATH)
  const loginEnv = getLoginEnv();
  const claudePath = agent.claudePath || 'claude';
  options.spawnClaudeCodeProcess = (spawnOpts) => {
    const command = spawnOpts.command || claudePath;
    const args = spawnOpts.args || [];
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...loginEnv, ...(spawnOpts.env || {}) },
    });
    return proc;
  };

  return options;
}

// ── SDK-based streaming chat ─────────────────────────────────────────────

async function streamClaudeCodeSDK(event, requestId, agent, prompt) {
  const sdk = await getClaudeSDK();
  if (!sdk) return false; // SDK not available, fall back to CLI

  const options = buildSDKOptions(agent);
  const abortController = new AbortController();
  options.abortController = abortController;

  // Permission handler — sends IPC to frontend, waits for response
  if (options.permissionMode !== 'bypassPermissions') {
    options.canUseTool = async (toolName, toolInput, permOpts) => {
      const approvalId = permOpts.toolUseID || `${requestId}-${Date.now()}`;

      event.sender.send('agent:permission-request', requestId, {
        toolUseId: approvalId,
        tool: toolName,
        input: toolInput,
        title: permOpts.title,
        description: permOpts.description,
        displayName: permOpts.displayName,
        timestamp: Date.now(),
      });

      return waitForToolApproval(approvalId);
    };
  }

  // Track the session
  const session = {
    status: 'running',
    startTime: Date.now(),
    abort: () => abortController.abort(),
    resolveToolApproval,
  };
  activeSDKSessions.set(requestId, session);
  activeClaudeProcs.set(requestId, {
    abort: () => abortController.abort(),
    sdkSession: true,
    resolveToolApproval,
  });

  let sessionId = null;
  const seenBlocks = new Set();

  try {
    const queryInstance = sdk.query({ prompt, options });

    for await (const message of queryInstance) {
      if (!message || !message.type) continue;

      // System init — capture session ID
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        continue;
      }

      // Stream events — token-by-token deltas
      if (message.type === 'stream_event' && message.event) {
        const evt = message.event;
        if (evt.type === 'content_block_delta') {
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            event.sender.send('agent:stream-chunk', requestId, evt.delta.text);
          }
          if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
            event.sender.send('agent:stream-thinking', requestId, evt.delta.thinking);
          }
        }
        if (evt.type === 'content_block_start' && evt.index != null) {
          seenBlocks.add(evt.index);
        }
        continue;
      }

      // Complete assistant messages — emit tool_use + fallback text
      if (message.type === 'assistant' && message.message?.content) {
        for (let i = 0; i < message.message.content.length; i++) {
          const block = message.message.content[i];
          if (block.type === 'tool_use') {
            event.sender.send('agent:stream-tool-use', requestId, {
              id: block.id,
              tool: block.name,
              input: block.input,
            });
          }
          if (!seenBlocks.has(i)) {
            if (block.type === 'text' && block.text) {
              event.sender.send('agent:stream-chunk', requestId, block.text);
            }
            if (block.type === 'thinking' && block.thinking) {
              event.sender.send('agent:stream-thinking', requestId, block.thinking);
            }
          }
        }
        seenBlocks.clear();
        continue;
      }

      // Result — capture session ID
      if (message.type === 'result') {
        sessionId = message.session_id || sessionId;
        continue;
      }
    }

    session.status = 'completed';
    session.completedAt = Date.now();
    event.sender.send('agent:stream-done', requestId, { sessionId });
    return true;
  } catch (err) {
    session.status = 'completed';
    session.completedAt = Date.now();
    const msg = err.message || '';
    if (err.name === 'AbortError' || msg.includes('aborted')) {
      event.sender.send('agent:stream-done', requestId, { sessionId });
    } else if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
      event.sender.send('agent:stream-error', requestId, 'Claude Code is not authenticated. Click Login below to sign in.');
    } else {
      event.sender.send('agent:stream-error', requestId, msg);
    }
    return true;
  } finally {
    activeClaudeProcs.delete(requestId);
  }
}

// ── SDK-based non-streaming chat ─────────────────────────────────────────

async function chatClaudeCodeSDK(agent, prompt) {
  const sdk = await getClaudeSDK();
  if (!sdk) return null; // SDK not available, fall back to CLI

  const options = buildSDKOptions(agent);
  const abortController = new AbortController();
  options.abortController = abortController;

  // For non-streaming, auto-allow tools (no UI to approve)
  // unless bypass is set
  if (options.permissionMode !== 'bypassPermissions') {
    options.permissionMode = 'acceptEdits';
  }

  let sessionId = null;
  let resultText = '';

  try {
    const queryInstance = sdk.query({ prompt, options });

    for await (const message of queryInstance) {
      if (!message || !message.type) continue;

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        continue;
      }

      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            resultText += block.text;
          }
        }
        continue;
      }

      if (message.type === 'result') {
        sessionId = message.session_id || sessionId;
        if (message.result) resultText = message.result;
        continue;
      }
    }

    return { content: resultText, sessionId };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
      return { error: 'Claude Code is not authenticated. Click Login below to sign in.' };
    }
    return { error: msg };
  }
}

// ── Strip ANSI / spinner noise (CLI fallback) ────────────────────────────

function extractClaudeCodeResponse(output) {
  try {
    const data = JSON.parse(output);
    if (data.result) return data.result;
    if (data.content) return data.content;
    if (data.text) return data.text;
  } catch { /* not JSON */ }
  return output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l => l.trim() && !/^[\u256d\u2570\u2502\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/.test(l))
    .join('\n')
    .trim() || output.trim();
}

// ── Build CLI args from agent config (CLI fallback) ──────────────────────

function buildCLIArgs(agent, extra = []) {
  const args = ['-p'];

  if (agent.model) args.push('--model', agent.model);

  const perm = agent.permissionMode || 'default';
  if (perm === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', perm);
  }

  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean).join(',');
    args.push('--allowedTools', tools);
  }

  if (agent.sessionId) {
    args.push('--resume', agent.sessionId);
  } else if (agent.continueSession) {
    args.push('--continue');
  }

  if (agent.systemPrompt) {
    args.push('--system-prompt', agent.systemPrompt);
  }

  args.push(...extra);
  return args;
}

// ── Spawn a claude process (CLI fallback) ────────────────────────────────

function spawnClaude(agent, args) {
  const claudePath = agent.claudePath || 'claude';
  const cwd = agent.workDir || process.env.HOME;
  return spawn(claudePath, args, { cwd, env: getLoginEnv() });
}

// ── Non-streaming chat (tries SDK first, falls back to CLI) ──────────────

async function chatClaudeCode(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const prompt = lastUserMsg.content || '';

  // Try SDK first
  if (agent.useSDK !== false) {
    const sdkResult = await chatClaudeCodeSDK(agent, prompt);
    if (sdkResult) return sdkResult;
  }

  // Fall back to CLI
  const args = buildCLIArgs(agent, ['--output-format', 'json']);

  return new Promise((resolve) => {
    const proc = spawnClaude(agent, args);
    let stdout = '';
    let stderr = '';

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ error: 'Claude Code timed out' });
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout);
        resolve({
          content: data.result || data.text || stdout.trim(),
          sessionId: data.session_id,
        });
      } catch {
        if (stdout.trim()) {
          resolve({ content: extractClaudeCodeResponse(stdout) });
        } else {
          const errMsg = stderr.trim() || `claude exited with code ${code}`;
          if (errMsg.includes('401') || errMsg.includes('authentication') || errMsg.includes('not authenticated')) {
            resolve({ error: 'Claude Code is not authenticated. Click Login below to sign in.' });
          } else {
            resolve({ error: errMsg });
          }
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err.message });
    });
  });
}

// ── Streaming chat (tries SDK first, falls back to CLI) ──────────────────

async function streamClaudeCode(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const prompt = lastUserMsg.content || '';

  // Try SDK first
  if (agent.useSDK !== false) {
    try {
      const used = await streamClaudeCodeSDK(event, requestId, agent, prompt);
      if (used) return;
    } catch (err) {
      // SDK failed to load or crashed — fall through to CLI
      activeClaudeProcs.delete(requestId);
    }
  }

  // Fall back to CLI spawning
  const args = buildCLIArgs(agent, [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]);

  const proc = spawnClaude(agent, args);

  // Send prompt using stream-json protocol (keeps stdin open for permissions)
  const userMsg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    session_id: null,
  });
  proc.stdin.write(userMsg + '\n');

  let buffer = '';
  let stderrOutput = '';
  let sessionId = null;
  let settled = false;
  const seenBlocks = new Set();

  activeClaudeProcs.set(requestId, {
    abort: () => proc.kill(),
    stdin: proc.stdin,
  });

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // System init — capture session ID
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
          continue;
        }

        // Stream events — token-by-token deltas wrapped in stream_event
        if (msg.type === 'stream_event' && msg.event) {
          const evt = msg.event;
          if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              event.sender.send('agent:stream-chunk', requestId, evt.delta.text);
            }
            if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              event.sender.send('agent:stream-thinking', requestId, evt.delta.thinking);
            }
          }
          if (evt.type === 'content_block_start' && evt.index != null) {
            seenBlocks.add(evt.index);
          }
          continue;
        }

        // Complete assistant messages — emit tool_use + fallback text
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
            if (!seenBlocks.has(i)) {
              if (block.type === 'text' && block.text) {
                event.sender.send('agent:stream-chunk', requestId, block.text);
              }
              if (block.type === 'thinking' && block.thinking) {
                event.sender.send('agent:stream-thinking', requestId, block.thinking);
              }
            }
          }
          seenBlocks.clear();
          continue;
        }

        // Permission request — forward to frontend for approval
        if (msg.type === 'control_request' && msg.subtype === 'can_use_tool') {
          event.sender.send('agent:permission-request', requestId, {
            toolUseId: msg.request_id,
            tool: msg.tool_name,
            input: msg.input,
            timestamp: Date.now(),
          });
          continue;
        }

        // Result — final session ID, close stdin
        if (msg.type === 'result') {
          sessionId = msg.session_id || sessionId;
          try { proc.stdin.end(); } catch { /* already closed */ }
          continue;
        }
      } catch {
        // Not valid JSON — emit as raw text
        if (line.trim()) {
          event.sender.send('agent:stream-chunk', requestId, line);
        }
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrOutput += text;
  });

  // Activity-based timeout (10 min, resets on any output)
  let timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    proc.kill();
    event.sender.send('agent:stream-error', requestId, 'Claude Code timed out');
  }, 600000);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'Claude Code timed out');
    }, 600000);
  };
  proc.stdout.on('data', resetTimer);
  proc.stderr.on('data', resetTimer);

  return new Promise((resolve) => {
    proc.on('close', (code) => {
      if (settled) return resolve();
      settled = true;
      clearTimeout(timer);
      activeClaudeProcs.delete(requestId);

      if (code !== 0 && stderrOutput.trim()) {
        const err = stderrOutput.trim();
        if (err.includes('401') || err.includes('authentication') || err.includes('not authenticated')) {
          event.sender.send('agent:stream-error', requestId, 'Claude Code is not authenticated. Click Login below to sign in.');
        } else {
          event.sender.send('agent:stream-error', requestId, err);
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
      activeClaudeProcs.delete(requestId);
      event.sender.send('agent:stream-error', requestId, err.message);
      resolve();
    });
  });
}

// ── Local ping (version check) ───────────────────────────────────────────

async function pingClaudeCode(agent) {
  try {
    const claudePath = agent.claudePath || 'claude';
    const output = await runLocalCommand(claudePath, ['--version'], { timeout: 10000 });

    // Check if SDK is available
    const sdk = await getClaudeSDK();
    const sdkInfo = sdk ? ' (SDK)' : ' (CLI)';

    return { online: true, info: output.trim() + sdkInfo };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Non-streaming chat via SSH ────────────────────────────────────────────

async function chatClaudeCodeSSH(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const prompt = lastUserMsg.content || '';

  // Try SDK first (with SSH spawner)
  if (agent.useSDK !== false) {
    const sdkResult = await chatClaudeCodeSDKviaSSH(agent, prompt);
    if (sdkResult) return sdkResult;
  }

  // Fall back to CLI-over-SSH
  const escapedMsg = prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  const workDir = agent.workDir || '~';

  let cmd = `cd ${workDir} && claude -p --output-format json`;
  if (agent.model) cmd += ` --model '${agent.model}'`;

  if (agent.sessionId) {
    cmd += ` --resume '${agent.sessionId}'`;
  } else if (agent.continueSession) {
    cmd += ` --continue`;
  }

  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    cmd += ' --dangerously-skip-permissions';
  } else {
    cmd += ` --permission-mode '${permMode}'`;
  }

  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean).join(',');
    cmd += ` --allowedTools '${tools}'`;
  }

  if (agent.systemPrompt) {
    const escapedPrompt = agent.systemPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    cmd += ` --system-prompt "${escapedPrompt}"`;
  }

  cmd += ` "${escapedMsg}" 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    try {
      const data = JSON.parse(output);
      return { content: data.result || data.content || data.text || output.trim(), sessionId: data.session_id };
    } catch {
      return { content: extractClaudeCodeResponse(output) };
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

// ── Streaming chat via SSH ────────────────────────────────────────────────

async function streamClaudeCodeSSH(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const prompt = lastUserMsg.content || '';

  // Try SDK first (with SSH spawner)
  if (agent.useSDK !== false) {
    try {
      const used = await streamClaudeCodeSDKviaSSH(event, requestId, agent, prompt);
      if (used) return;
    } catch (err) {
      // SDK failed — fall through to CLI-over-SSH
      activeClaudeProcs.delete(requestId);
    }
  }

  // Fall back to CLI-over-SSH
  const escapedMsg = prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  const workDir = agent.workDir || '~';

  let cmd = `cd ${workDir} && claude -p --output-format stream-json --verbose --include-partial-messages`;
  if (agent.model) cmd += ` --model '${agent.model}'`;

  if (agent.sessionId) {
    cmd += ` --resume '${agent.sessionId}'`;
  } else if (agent.continueSession) {
    cmd += ` --continue`;
  }

  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    cmd += ' --dangerously-skip-permissions';
  } else {
    cmd += ` --permission-mode '${permMode}'`;
  }

  if (agent.allowedTools) {
    const tools = agent.allowedTools.split(/[,\s]+/).filter(Boolean).join(',');
    cmd += ` --allowedTools '${tools}'`;
  }

  if (agent.systemPrompt) {
    const escapedPrompt = agent.systemPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    cmd += ` --system-prompt "${escapedPrompt}"`;
  }

  cmd += ` "${escapedMsg}"`;

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
  const seenBlocks = new Set();

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id;
          continue;
        }

        if (msg.type === 'content_block_delta') {
          if (msg.delta?.type === 'text_delta' && msg.delta.text) {
            event.sender.send('agent:stream-chunk', requestId, msg.delta.text);
          }
          if (msg.delta?.type === 'thinking_delta' && msg.delta.thinking) {
            event.sender.send('agent:stream-thinking', requestId, msg.delta.thinking);
          }
          continue;
        }

        if (msg.type === 'content_block_start' && msg.index != null) {
          seenBlocks.add(msg.index);
          continue;
        }

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
            if (!seenBlocks.has(i)) {
              if (block.type === 'text' && block.text) {
                event.sender.send('agent:stream-chunk', requestId, block.text);
              }
              if (block.type === 'thinking' && block.thinking) {
                event.sender.send('agent:stream-thinking', requestId, block.thinking);
              }
            }
          }
          seenBlocks.clear();
          continue;
        }

        if (msg.type === 'result') {
          sessionId = msg.session_id || sessionId;
          continue;
        }
      } catch {
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

  return new Promise((resolve) => {
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

// ── SSH ping ──────────────────────────────────────────────────────────────

async function pingClaudeCodeSSH(agent) {
  try {
    const output = await runSSHCommand(agent, 'claude --version 2>&1', 15000);
    const sdk = await getClaudeSDK();
    const sdkInfo = sdk ? ' (SDK via SSH)' : ' (CLI via SSH)';
    return { online: true, info: output.trim() + sdkInfo };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  buildCLIArgs,
  extractClaudeCodeResponse,
  chatClaudeCode,
  streamClaudeCode,
  pingClaudeCode,
  chatClaudeCodeSSH,
  streamClaudeCodeSSH,
  pingClaudeCodeSSH,
  // SDK-specific exports for permission handling
  resolveToolApproval,
  activeSDKSessions,
};
