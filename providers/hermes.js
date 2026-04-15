const { spawn } = require('child_process');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand, getLoginEnv } = require('../lib/local');
const { shellQuote, buildRemoteCdCommand } = require('../lib/shell');
const { activeClaudeProcs } = require('../lib/state');

// ── Constants ─────────────────────────────────────────────────────────────

const CHAT_TIMEOUT = 0;              // no timeout — streaming waits for agent to finish
const CHAT_TIMEOUT_NONSTREAM = 24 * 60 * 60 * 1000; // 24h fallback for non-streaming calls
const PING_TIMEOUT = 15000;          // 15s for health checks

// ── Noise filtering ───────────────────────────────────────────────────────
// Hermes outputs log lines, spinners, and status messages before the actual
// response. These are dropped so only the agent's reply streams to the UI.

const NOISE_PATTERNS = [
  /^\[hermes\]/i,
  /^\[info\]/i,
  /^\[debug\]/i,
  /^\[warn\]/i,
  /^\[error\]/i,
  /^Thinking\.\.\./i,
  /^Loading/i,
  /^Connecting/i,
  /^Initializing/i,
];

// Braille spinner characters used in hermes TUI
const SPINNER_CHARS = new Set([
  '\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834',
  '\u2826', '\u2827', '\u2807', '\u280F',
]);

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (SPINNER_CHARS.has(t[0])) return true;
  return NOISE_PATTERNS.some(p => p.test(t));
}

function extractHermesResponse(output) {
  return output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l => !isNoiseLine(l))
    .join('\n')
    .trim() || output.trim();
}

// ── Build CLI command ─────────────────────────────────────────────────────
// When agent.sessionId is set, we add --continue so hermes resumes the most
// recent session instead of starting a new one.  The UI persists sessionId
// across messages and clears it on /clear, giving us automatic session
// lifecycle management.

function buildHermesShellCmd(agent, message) {
  let cmd = 'hermes chat';
  if (agent.sessionId) cmd += ' --continue';
  if (agent.hermesProvider) cmd += ` --provider ${shellQuote(agent.hermesProvider)}`;
  if (agent.hermesWorktree) cmd += ` --worktree ${shellQuote(agent.hermesWorktree)}`;
  cmd += ` -q ${shellQuote(message)}`;
  return cmd;
}

// ── SSH helpers ───────────────────────────────────────────────────────────

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

// ── Core streaming handler ────────────────────────────────────────────────
// Spawns a process running the hermes CLI and streams filtered stdout to
// the UI in real-time.  Noise lines at the start are silently dropped.
// Once the first real content line appears, everything streams through
// unmodified — exactly like watching hermes in a terminal.

function streamFromProcess(proc, event, requestId, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let sawContent = false;
    let pastNoise = false;
    let lineBuffer = '';
    let stderrBuf = '';

    function sendChunk(text) {
      if (!text) return;
      // Strip ANSI codes from streamed output
      const cleaned = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
      if (cleaned) {
        sawContent = true;
        event.sender.send('agent:stream-chunk', requestId, cleaned);
      }
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();

      // Once past noise section, stream everything through
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

    // Activity-based timeout — resets on any stdout/stderr data
    // When timeout is 0/falsy, no timer is set — we wait indefinitely for the agent to finish.
    let timer = null;

    if (timeout) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        event.sender.send('agent:stream-error', requestId, 'Hermes command timeout');
        resolve();
      }, timeout);

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill();
          event.sender.send('agent:stream-error', requestId, 'Hermes command timeout');
          resolve();
        }, timeout);
      };
      proc.stdout.on('data', resetTimer);
      proc.stderr.on('data', resetTimer);
    }

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      // Flush any remaining buffered content
      if (lineBuffer.trim()) {
        if (pastNoise || !isNoiseLine(lineBuffer)) {
          sendChunk(lineBuffer);
        }
      }

      if (code !== 0 && !sawContent) {
        const errMsg = stderrBuf.trim() || `hermes exited with code ${code}`;
        if (errMsg.includes('command not found')) {
          event.sender.send('agent:stream-error', requestId,
            'Hermes is not installed. Install it and try again.');
        } else {
          event.sender.send('agent:stream-error', requestId, errMsg);
        }
      } else {
        // Signal active session so the UI persists it — on follow-up messages
        // buildHermesShellCmd will see agent.sessionId and add --continue.
        event.sender.send('agent:stream-done', requestId, { sessionId: 'hermes-active' });
      }
      resolve();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      resolve();
    });
  });
}

// ── Local: streaming ──────────────────────────────────────────────────────

async function streamHermesLocal(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const workDir = agent.workDir || process.env.HOME;
  const cmd = buildHermesShellCmd(agent, lastUserMsg.content) + ' 2>&1';

  const proc = spawn('bash', ['-l', '-c', cmd], { cwd: workDir });

  activeClaudeProcs.set(requestId, {
    abort: () => proc.kill(),
  });

  try {
    await streamFromProcess(proc, event, requestId, CHAT_TIMEOUT);
  } finally {
    activeClaudeProcs.delete(requestId);
  }
}

// ── Local: non-streaming chat ─────────────────────────────────────────────

async function chatHermesLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const workDir = agent.workDir || process.env.HOME;
  const cmd = buildHermesShellCmd(agent, lastUserMsg.content) + ' 2>&1';

  try {
    const output = await runLocalCommand('bash', ['-l', '-c', cmd], {
      cwd: workDir,
      timeout: CHAT_TIMEOUT_NONSTREAM,
    });
    return { content: extractHermesResponse(output), sessionId: 'hermes-active' };
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractHermesResponse(errMsg);
    if (content && content.length > 10 &&
        !content.includes('Permission denied') &&
        !content.includes('command not found')) {
      return { content, sessionId: 'hermes-active' };
    }
    return { error: err.message };
  }
}

// ── Local: ping ───────────────────────────────────────────────────────────

async function pingHermesLocal() {
  try {
    const output = await runLocalCommand('bash', ['-l', '-c', 'hermes --version 2>&1'], {
      timeout: PING_TIMEOUT,
    });
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── SSH: streaming ────────────────────────────────────────────────────────

async function streamHermes(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const workDir = agent.workDir || agent.hermesWorktree || '~';
  const cmd = `${buildRemoteCdCommand(workDir)} && ${buildHermesShellCmd(agent, lastUserMsg.content)} 2>&1`;

  const sshArgs = [...buildSSHArgs(agent), `bash -l -c ${JSON.stringify(cmd)}`];
  const proc = spawn('ssh', sshArgs);

  activeClaudeProcs.set(requestId, {
    abort: () => proc.kill(),
  });

  try {
    await streamFromProcess(proc, event, requestId, CHAT_TIMEOUT);
  } finally {
    activeClaudeProcs.delete(requestId);
  }
}

// ── SSH: non-streaming chat ───────────────────────────────────────────────

async function chatHermes(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''");

  let cmd = 'hermes chat';
  if (agent.sessionId) cmd += ' --continue';
  if (agent.hermesProvider) cmd += ` --provider '${agent.hermesProvider}'`;
  if (agent.hermesWorktree) cmd += ` --worktree '${agent.hermesWorktree}'`;
  cmd += ` -q '${escapedMsg}' 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, CHAT_TIMEOUT_NONSTREAM, { singleQuoteWrap: true });
    return { content: extractHermesResponse(output), sessionId: 'hermes-active' };
  } catch (err) {
    const errMsg = err.message || '';
    const content = extractHermesResponse(errMsg);
    if (content && content.length > 20 &&
        !content.includes('Permission denied') &&
        !content.includes('Connection refused')) {
      return { content, sessionId: 'hermes-active' };
    }
    return { error: err.message };
  }
}

// ── SSH: ping ─────────────────────────────────────────────────────────────

async function pingHermes(agent) {
  try {
    const output = await runSSHCommand(agent, 'hermes --version 2>&1', PING_TIMEOUT);
    return { online: true, info: output.trim() };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  chatHermes,
  streamHermes,
  pingHermes,
  chatHermesLocal,
  streamHermesLocal,
  pingHermesLocal,
};
