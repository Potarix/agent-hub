const { spawn } = require('child_process');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand, getLoginEnv } = require('../lib/local');
const { activeClaudeProcs } = require('../lib/state');

// ── Strip ANSI / spinner noise ────────────────────────────────────────────

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

// ── Build CLI args from agent config ──────────────────────────────────────

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

// ── Spawn a claude process ────────────────────────────────────────────────

function spawnClaude(agent, args) {
  const claudePath = agent.claudePath || 'claude';
  const cwd = agent.workDir || process.env.HOME;
  return spawn(claudePath, args, { cwd, env: getLoginEnv() });
}

// ── Non-streaming chat via CLI ────────────────────────────────────────────

async function chatClaudeCode(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const prompt = lastUserMsg.content || '';
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

// ── Streaming chat via CLI ────────────────────────────────────────────────

async function streamClaudeCode(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const prompt = lastUserMsg.content || '';
  const args = buildCLIArgs(agent, [
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]);

  const proc = spawnClaude(agent, args);
  proc.stdin.write(prompt);
  proc.stdin.end();

  let buffer = '';
  let stderrOutput = '';
  let sessionId = null;
  let settled = false;
  const seenBlocks = new Set();

  activeClaudeProcs.set(requestId, {
    abort: () => proc.kill(),
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

        // Track blocks streamed via deltas for dedup
        if (msg.type === 'content_block_start' && msg.index != null) {
          seenBlocks.add(msg.index);
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

        // Result — final session ID
        if (msg.type === 'result') {
          sessionId = msg.session_id || sessionId;
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
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Non-streaming chat via SSH ────────────────────────────────────────────

async function chatClaudeCodeSSH(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const escapedMsg = lastUserMsg.content
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

  const escapedMsg = lastUserMsg.content
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
    return { online: true, info: output.trim() };
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
};
