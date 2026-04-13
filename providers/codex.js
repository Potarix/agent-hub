const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runSSHCommand } = require('../lib/ssh');
const { getLoginEnv, runLocalCommand } = require('../lib/local');
const { shellQuote, buildRemoteCdCommand, expandHomeDir } = require('../lib/shell');
const { activeClaudeProcs } = require('../lib/state');

// ── SDK lazy loaders ──

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

// ── Helpers ──

function extractCodexResponse(output) {
  // Strip ANSI escape codes and noise
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

function buildCodexExecArgs(agent, { stdinPrompt = false, json = false } = {}) {
  const args = ['exec', '--full-auto', '--color', 'never'];
  if (json) args.push('--json');
  if (agent.skipGitRepoCheck !== false) args.push('--skip-git-repo-check');
  if (agent.model) args.push('--model', agent.model);
  if (agent.codexArgs) args.push(...agent.codexArgs.split(/\s+/).filter(Boolean));
  if (stdinPrompt) args.push('-');
  return args;
}

function buildCodexExecShellCommand(agent, { stdinPrompt = false, json = false } = {}) {
  const parts = ['codex', 'exec', '--full-auto', '--color', 'never'];
  if (json) parts.push('--json');
  if (agent.skipGitRepoCheck !== false) parts.push('--skip-git-repo-check');
  if (agent.model) parts.push('--model', shellQuote(agent.model));
  if (agent.codexArgs) parts.push(agent.codexArgs);
  if (stdinPrompt) parts.push('-');
  return parts.join(' ');
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

// ── Event forwarder ──

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

// ── SDK-based streaming/chat ──

async function streamCodexWithAgentsSDK(event, requestId, agent, userMsg) {
  const apiKey = getCodexApiKey(agent);
  if (!apiKey) return false;

  const { Agent, run, setDefaultOpenAIKey } = await getOpenAIAgentsSDK();
  const { codexTool } = await getOpenAICodexToolSDK();

  setDefaultOpenAIKey(apiKey);

  // Build prompt with image support
  let prompt = typeof userMsg === 'string' ? userMsg : userMsg.content || '';

  // If there are images, create multi-part content
  if (typeof userMsg === 'object' && userMsg.images && userMsg.images.length > 0) {
    // For OpenAI Agents SDK, we might need to pass images differently
    // For now, we'll add a note about attached images
    prompt += '\n\n[User has attached images to this message]';
  }

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

async function streamCodexWithCodexSDK(event, requestId, agent, userMsg) {
  const { Codex } = await getCodexSDK();
  const apiKey = getCodexApiKey(agent);
  const codex = new Codex(buildCodexSDKOptions(agent, apiKey));
  const threadOptions = buildCodexThreadOptions(agent);
  const thread = agent.sessionId ? codex.resumeThread(agent.sessionId, threadOptions) : codex.startThread(threadOptions);

  // Build prompt with image support
  let prompt = typeof userMsg === 'string' ? userMsg : userMsg.content || '';

  // If there are images, add a note about them
  if (typeof userMsg === 'object' && userMsg.images && userMsg.images.length > 0) {
    prompt += '\n\n[User has attached images to this message]';
  }
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

async function chatCodexWithCodexSDK(agent, userMsg) {
  const { Codex } = await getCodexSDK();
  const apiKey = getCodexApiKey(agent);
  const codex = new Codex(buildCodexSDKOptions(agent, apiKey));
  const threadOptions = buildCodexThreadOptions(agent);
  const thread = agent.sessionId ? codex.resumeThread(agent.sessionId, threadOptions) : codex.startThread(threadOptions);

  // Build prompt with image support
  let prompt = typeof userMsg === 'string' ? userMsg : userMsg.content || '';

  // If there are images, add a note about them
  if (typeof userMsg === 'object' && userMsg.images && userMsg.images.length > 0) {
    prompt += '\n\n[User has attached images to this message]';
  }

  const turn = await thread.run(prompt);
  return { content: turn.finalResponse || '', sessionId: thread.id, usage: turn.usage };
}

// ── Local entry points ──

async function streamCodexLocal(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  if (agent.useCodexSDK !== false) {
    try {
      const usedAgentsSDK = await streamCodexWithAgentsSDK(event, requestId, agent, lastUserMsg);
      if (usedAgentsSDK) return;

      await streamCodexWithCodexSDK(event, requestId, agent, lastUserMsg);
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
  const homeDir = os.homedir();
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

  // If we have ChatGPT auth, use the codex CLI with JSONL event streaming
  if (hasCodexAuth) {
    const codexPath = agent.codexPath || 'codex';
    const workDir = agent.workDir || process.env.HOME;

    return new Promise((resolve) => {
      const args = buildCodexExecArgs(agent, { stdinPrompt: true, json: true });

      const proc = spawn(codexPath, args, {
        env: { ...getLoginEnv() },
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdin.write(lastUserMsg.content);
      proc.stdin.end();

      const forwarder = createCodexEventForwarder(event, requestId);
      let buffer = '';
      let stderrBuf = '';
      let settled = false;

      activeClaudeProcs.set(requestId, {
        abort: () => proc.kill(),
      });

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            forwarder.handle(evt);
          } catch {
            // Not JSON — strip ANSI and send as raw text
            const cleaned = line
              .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
              .replace(/\r/g, '');
            if (cleaned.trim()) {
              event.sender.send('agent:stream-chunk', requestId, cleaned + '\n');
              forwarder.markContentSent();
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderrBuf += data.toString();
      });

      // Activity-based timeout — resets on any stdout/stderr data
      const timeout = agent.timeout || 300000;
      let timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        event.sender.send('agent:stream-error', requestId, 'Codex command timeout');
        resolve();
      }, timeout);

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill();
          event.sender.send('agent:stream-error', requestId, 'Codex command timeout');
          resolve();
        }, timeout);
      };
      proc.stdout.on('data', resetTimer);
      proc.stderr.on('data', resetTimer);

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeClaudeProcs.delete(requestId);

        if (!forwarder.sentAnyContent && code !== 0 && stderrBuf.trim()) {
          const errMsg = stderrBuf.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
          event.sender.send('agent:stream-error', requestId, errMsg || `Codex exited with code ${code}`);
        } else {
          event.sender.send('agent:stream-done', requestId, {
            sessionId: forwarder.threadId || null,
          });
        }
        resolve();
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeClaudeProcs.delete(requestId);
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
    '   \u2022 Add an API key to your agent configuration, or\n' +
    '   \u2022 Set OPENAI_API_KEY environment variable:\n' +
    '     export OPENAI_API_KEY=your-key-here\n\n' +
    'Get your API key from: https://platform.openai.com/api-keys'
  );
  return;
}

async function chatCodexLocal(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return { error: 'No user message found' };

  if (agent.useCodexSDK !== false) {
    try {
      return await chatCodexWithCodexSDK(agent, lastUserMsg);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('401') || msg.includes('authentication') || msg.includes('not authenticated')) {
        return { error: 'Codex is not authenticated. Run "codex auth" or set OPENAI_API_KEY.' };
      }
      return { error: msg };
    }
  }

  // Check if codex has ChatGPT auth
  const homeDir = os.homedir();
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
           '   \u2022 Add an API key to your agent configuration, or\n' +
           '   \u2022 Set OPENAI_API_KEY environment variable:\n' +
           '     export OPENAI_API_KEY=your-key-here\n\n' +
           'Get your API key from: https://platform.openai.com/api-keys'
  };
}

async function pingCodexLocal(agent) {
  // Check if codex has ChatGPT auth
  const homeDir = os.homedir();
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

// ── SSH entry points ──

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

  // Use --json for JSONL event streaming, pipe prompt via stdin
  const cmd = `${buildRemoteCdCommand(workDir)} && printf %s ${shellQuote(lastUserMsg.content)} | ${buildCodexExecShellCommand(agent, { stdinPrompt: true, json: true })}`;

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
  sshArgs.push(`${sshUser}@${sshHost}`, `bash -l -c ${JSON.stringify(cmd)}`);

  const proc = spawn('ssh', sshArgs);
  const forwarder = createCodexEventForwarder(event, requestId);
  let buffer = '';
  let stderrOutput = '';
  let settled = false;

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
        const evt = JSON.parse(line);
        forwarder.handle(evt);
      } catch {
        // Not JSON — strip ANSI and send as raw text
        const cleaned = line
          .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
          .replace(/\r/g, '');
        if (cleaned.trim()) {
          event.sender.send('agent:stream-chunk', requestId, cleaned + '\n');
          forwarder.markContentSent();
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

  // Activity-based timeout — resets on any output
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
      activeClaudeProcs.delete(requestId);

      if (code !== 0 && !forwarder.sentAnyContent && stderrOutput.trim()) {
        const errMsg = stderrOutput.trim();
        if (errMsg.includes('401') || errMsg.includes('authentication')) {
          event.sender.send('agent:stream-error', requestId, 'Invalid API key on remote. Check OPENAI_API_KEY.');
        } else if (errMsg.includes('429')) {
          event.sender.send('agent:stream-error', requestId, 'Rate limit exceeded. Please try again later.');
        } else {
          event.sender.send('agent:stream-error', requestId, errMsg);
        }
      } else {
        event.sender.send('agent:stream-done', requestId, {
          sessionId: forwarder.threadId || null,
        });
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

module.exports = {
  chatCodexLocal,
  streamCodexLocal,
  pingCodexLocal,
  chatCodexSSH,
  streamCodexSSH,
  pingCodexSSH,
};
