const { spawn } = require('child_process');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand, getLoginEnv } = require('../lib/local');
const { activeClaudeProcs } = require('../lib/state');

// ── Lazy-load Claude Code SDK ──────────────────────────────────────────────

let _claudeSDK = null;
async function getClaudeSDK() {
  if (!_claudeSDK) {
    try {
      _claudeSDK = await import('@anthropic-ai/claude-code');
    } catch {
      throw new Error('Claude Code SDK not installed. Run: npm install @anthropic-ai/claude-code');
    }
  }
  return _claudeSDK;
}

// ── Build options for SDK query ────────────────────────────────────────────

function buildClaudeSDKOptions(agent, extraOpts = {}) {
  const options = {
    cwd: agent.workDir || process.env.HOME,
    ...extraOpts,
  };
  if (agent.model) options.model = agent.model;
  const permMode = agent.permissionMode || 'acceptEdits';
  if (permMode === 'bypassPermissions') {
    options.dangerouslySkipPermissions = true;
  } else {
    options.permissionMode = permMode;
  }
  if (agent.allowedTools) {
    options.allowedTools = agent.allowedTools.split(/[,\s]+/).filter(Boolean);
  }
  if (agent.sessionId) {
    options.resume = agent.sessionId;
  } else if (agent.continueSession) {
    options.continue = true;
  }
  if (agent.systemPrompt) {
    options.systemPrompt = agent.systemPrompt;
  }
  return options;
}

// ── Strip ANSI / spinner noise from CLI output ─────────────────────────────

function extractClaudeCodeResponse(output) {
  try {
    const data = JSON.parse(output);
    if (data.result) return data.result;
    if (data.content) return data.content;
    if (data.text) return data.text;
  } catch { /* not JSON */ }
  const cleaned = output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l =>
      l.trim() &&
      !l.startsWith('\u256d') && !l.startsWith('\u2570') && !l.startsWith('\u2502') &&
      !l.startsWith('\u280b') && !l.startsWith('\u2819') && !l.startsWith('\u2839') &&
      !l.startsWith('\u2838') && !l.startsWith('\u283c') && !l.startsWith('\u2834') &&
      !l.startsWith('\u2826') && !l.startsWith('\u2827') && !l.startsWith('\u2807') && !l.startsWith('\u280f')
    )
    .join('\n')
    .trim();
  return cleaned || output.trim();
}

// ── Non-streaming chat via SDK ─────────────────────────────────────────────

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

// ── Streaming chat via SDK ─────────────────────────────────────────────────

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

// ── Local ping (version check) ────────────────────────────────────────────

async function pingClaudeCode(agent) {
  try {
    const claudePath = agent.claudePath || 'claude';
    const output = await runLocalCommand(claudePath, ['--version'], { timeout: 10000 });
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Non-streaming chat via SSH ─────────────────────────────────────────────

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

// ── Streaming chat via SSH ─────────────────────────────────────────────────

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

// ── SSH ping (version check) ──────────────────────────────────────────────

async function pingClaudeCodeSSH(agent) {
  try {
    const output = await runSSHCommand(agent, 'claude --version 2>&1', 15000);
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getClaudeSDK,
  buildClaudeSDKOptions,
  extractClaudeCodeResponse,
  chatClaudeCode,
  streamClaudeCode,
  pingClaudeCode,
  chatClaudeCodeSSH,
  streamClaudeCodeSSH,
  pingClaudeCodeSSH,
};
