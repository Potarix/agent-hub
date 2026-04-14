const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand } = require('../lib/local');

function extractOpenClawResponse(output) {
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

  let cmd = `openclaw agent --agent '${agentId}' --message '${escapedMsg}' --json 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000);
    const content = extractOpenClawResponse(output);
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

async function chatOpenClawLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  const agentId = agent.openclawAgent || 'main';
  const escapedMsg = lastUserMsg.content.replace(/'/g, "'\\''").replace(/"/g, '\\"');
  const workDir = agent.workDir || process.env.HOME;

  let cmd = `openclaw agent --agent '${agentId}' --message '${escapedMsg}' --json 2>&1`;

  try {
    const output = await runLocalCommand('bash', ['-l', '-c', cmd], { cwd: workDir, timeout: 24 * 60 * 60 * 1000 });
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

module.exports = {
  extractOpenClawResponse,
  chatOpenClaw,
  streamOpenClaw,
  pingOpenClaw,
  chatOpenClawLocal,
  pingOpenClawLocal,
};
