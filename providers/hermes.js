const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand } = require('../lib/local');

function extractHermesResponse(output) {
  const cleaned = output
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l =>
      l.trim() &&
      !l.startsWith('[hermes]') &&
      !l.startsWith('[info]') &&
      !l.startsWith('[debug]') &&
      !l.startsWith('[warn]') &&
      !l.startsWith('\u280B') && !l.startsWith('\u2819') && !l.startsWith('\u2839') &&
      !l.startsWith('\u2838') && !l.startsWith('\u283C') && !l.startsWith('\u2834') &&
      !l.startsWith('\u2826') && !l.startsWith('\u2827') && !l.startsWith('\u2807') && !l.startsWith('\u280F') &&
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

  // Build conversation context from message history
  let conversationContext = '';
  if (messages.length > 1) {
    // Include previous messages as context (excluding the last user message)
    const contextMessages = messages.slice(0, -1);
    conversationContext = contextMessages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');
    conversationContext += '\n\n';
  }

  // Combine context with current message
  const fullMessage = conversationContext + `User: ${lastUserMsg.content}\n\nAssistant:`;
  const escapedMsg = fullMessage.replace(/'/g, "'\\''");

  let cmd = 'hermes chat';
  if (agent.hermesProvider) cmd += ` --provider '${agent.hermesProvider}'`;
  if (agent.model) cmd += ` --model '${agent.model}'`;
  if (agent.hermesWorktree) cmd += ` --worktree '${agent.hermesWorktree}'`;
  cmd += ` -q '${escapedMsg}' 2>&1`;

  try {
    const output = await runSSHCommand(agent, cmd, 300000, { singleQuoteWrap: true });
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

async function chatHermesLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  // Build conversation context from message history
  let conversationContext = '';
  if (messages.length > 1) {
    // Include previous messages as context (excluding the last user message)
    const contextMessages = messages.slice(0, -1);
    conversationContext = contextMessages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');
    conversationContext += '\n\n';
  }

  // Combine context with current message
  const fullMessage = conversationContext + `User: ${lastUserMsg.content}\n\nAssistant:`;
  const escapedMsg = fullMessage.replace(/'/g, "'\\''");
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

module.exports = {
  chatHermes,
  pingHermes,
  chatHermesLocal,
  pingHermesLocal,
};
