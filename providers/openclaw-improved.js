const { spawn } = require('child_process');
const { runSSHCommand } = require('../lib/ssh');
const { runLocalCommand } = require('../lib/local');

// ── Response Parser ─────────────────────────────────────────────────────────

class OpenClawResponseParser {
  /**
   * Parse OpenClaw output with better error handling
   */
  static parse(output) {
    if (!output) return null;

    // Try to parse as JSON first
    try {
      const jsonMatch = output.match(/\{[\s\S]*"payloads"[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        const texts = (data.payloads || [])
          .map(p => p.text)
          .filter(Boolean);
        if (texts.length > 0) {
          return {
            content: texts.join('\n\n'),
            raw: data,
            type: 'json'
          };
        }
      }
    } catch (e) {
      // Continue to fallback parsing
    }

    // Fallback to text parsing with better filtering
    const filteredLines = output
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;

        // Filter out known noise patterns
        const noisePatterns = [
          /^gateway connect failed/i,
          /^gateway agent failed/i,
          /^gateway target:/i,
          /^source:/i,
          /^config:/i,
          /^bind:/i,
          /^warning:/i,
          /^\[.*\]$/,  // Log prefixes
          /^debug:/i,
          /^info:/i,
          /^error:/i
        ];

        return !noisePatterns.some(pattern => pattern.test(trimmed));
      });

    const content = filteredLines.join('\n').trim();
    return content ? { content, type: 'text' } : null;
  }

  /**
   * Extract error information from output
   */
  static extractError(output) {
    if (!output) return 'Unknown error';

    const errorPatterns = [
      { pattern: /permission denied/i, message: 'Permission denied - check OpenClaw permissions' },
      { pattern: /connection refused/i, message: 'Connection refused - OpenClaw may not be running' },
      { pattern: /command not found/i, message: 'OpenClaw command not found - ensure it is installed' },
      { pattern: /authentication/i, message: 'Authentication failed - check OpenClaw credentials' },
      { pattern: /timeout/i, message: 'Operation timed out' },
      { pattern: /not authenticated/i, message: 'OpenClaw is not authenticated' }
    ];

    for (const { pattern, message } of errorPatterns) {
      if (pattern.test(output)) {
        return message;
      }
    }

    // Try to extract meaningful error from output
    const parsed = this.parse(output);
    if (parsed?.content) {
      return parsed.content;
    }

    return output.slice(0, 200); // Return first 200 chars as fallback
  }
}

// ── Command Builder ─────────────────────────────────────────────────────────

class OpenClawCommandBuilder {
  constructor(agent, message) {
    this.agent = agent;
    this.message = message;
    this.agentId = agent.openclawAgent || 'main';
  }

  /**
   * Properly escape shell arguments using single quotes
   * Single quotes preserve everything except single quotes themselves
   */
  escapeShellArg(arg) {
    if (!arg) return "''";
    // Replace single quotes with '\'' (end quote, escaped quote, start quote)
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  /**
   * Build the OpenClaw command with proper escaping
   */
  build() {
    const parts = [
      'openclaw',
      'agent',
      '--agent', this.escapeShellArg(this.agentId),
      '--message', this.escapeShellArg(this.message),
      '--json',
      '2>&1'
    ];

    return parts.join(' ');
  }

  /**
   * Build command for local execution with working directory
   */
  buildLocal() {
    const cmd = this.build();
    const workDir = this.agent.workDir || process.env.HOME;
    return { cmd, workDir };
  }
}

// ── Execution Manager ───────────────────────────────────────────────────────

class OpenClawExecutor {
  constructor(timeout = 300000) {
    this.timeout = timeout;
  }

  /**
   * Execute OpenClaw command via SSH
   */
  async executeSSH(agent, command) {
    try {
      const output = await runSSHCommand(agent, command, this.timeout);
      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'SSH execution failed',
        output: error.message
      };
    }
  }

  /**
   * Execute OpenClaw command locally
   */
  async executeLocal(command, workDir) {
    try {
      const output = await runLocalCommand(
        'bash',
        ['-l', '-c', command],
        { cwd: workDir, timeout: this.timeout }
      );
      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Local execution failed',
        output: error.message
      };
    }
  }

  /**
   * Execute with streaming support
   */
  async executeStream(agent, command, onData, onError) {
    const isLocal = !agent.sshHost;

    if (isLocal) {
      return this.executeLocalStream(command, agent.workDir, onData, onError);
    } else {
      return this.executeSSHStream(agent, command, onData, onError);
    }
  }

  /**
   * Stream execution locally
   */
  async executeLocalStream(command, workDir, onData, onError) {
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-l', '-c', command], {
        cwd: workDir || process.env.HOME
      });

      let buffer = '';
      let errorBuffer = '';
      let hasError = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            onData(line);
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        errorBuffer += chunk.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        onError('Command timeout');
        hasError = true;
      }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        // Process any remaining buffer
        if (buffer.trim()) {
          onData(buffer);
        }

        if (!hasError) {
          if (code !== 0 && errorBuffer) {
            onError(errorBuffer);
          }
          resolve({ code, output: buffer, error: errorBuffer });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        onError(err.message);
        hasError = true;
        resolve({ error: err.message });
      });
    });
  }

  /**
   * Stream execution via SSH
   */
  async executeSSHStream(agent, command, onData, onError) {
    const sshUser = agent.sshUser || 'root';
    const sshHost = agent.sshHost;
    const sshPort = agent.sshPort || 22;
    const sshKey = agent.sshKey || '';

    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-p', String(sshPort)
    ];

    if (sshKey) {
      sshArgs.push('-i', sshKey);
    }

    const wrappedCommand = `bash -l -c ${JSON.stringify(command)}`;
    sshArgs.push(`${sshUser}@${sshHost}`, wrappedCommand);

    return new Promise((resolve) => {
      const proc = spawn('ssh', sshArgs);

      let buffer = '';
      let errorBuffer = '';
      let hasError = false;

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim()) {
            onData(line);
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (!text.includes('Warning:') && !text.includes('Permanently added')) {
          errorBuffer += text;
        }
      });

      const timeout = setTimeout(() => {
        proc.kill();
        onError('SSH command timeout');
        hasError = true;
      }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        // Process any remaining buffer
        if (buffer.trim()) {
          onData(buffer);
        }

        if (!hasError) {
          if (code !== 0 && errorBuffer) {
            onError(errorBuffer);
          }
          resolve({ code, output: buffer, error: errorBuffer });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        onError(err.message);
        hasError = true;
        resolve({ error: err.message });
      });
    });
  }
}

// ── Main API Functions ──────────────────────────────────────────────────────

/**
 * Chat with OpenClaw (non-streaming)
 */
async function chatOpenClaw(agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    return { error: 'No user message found' };
  }

  const builder = new OpenClawCommandBuilder(agent, lastUserMsg.content);
  const executor = new OpenClawExecutor();

  const isLocal = !agent.sshHost;
  let result;

  if (isLocal) {
    const { cmd, workDir } = builder.buildLocal();
    result = await executor.executeLocal(cmd, workDir);
  } else {
    const cmd = builder.build();
    result = await executor.executeSSH(agent, cmd);
  }

  // Parse response
  if (result.success) {
    const parsed = OpenClawResponseParser.parse(result.output);
    if (parsed?.content) {
      return { content: parsed.content };
    }
  }

  // Handle errors
  const errorMsg = OpenClawResponseParser.extractError(result.output || result.error);

  // Check if we got a valid response despite error code
  const parsed = OpenClawResponseParser.parse(result.output);
  if (parsed?.content && parsed.content.length > 10) {
    return { content: parsed.content };
  }

  return { error: errorMsg };
}

/**
 * Stream OpenClaw responses
 */
async function streamOpenClaw(event, requestId, agent, messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    event.sender.send('agent:stream-error', requestId, 'No user message found');
    return;
  }

  const builder = new OpenClawCommandBuilder(agent, lastUserMsg.content);
  const executor = new OpenClawExecutor();

  let fullOutput = '';
  let hasContent = false;

  const onData = (line) => {
    fullOutput += line + '\n';

    // Try to parse and extract content from each line
    const parsed = OpenClawResponseParser.parse(line);
    if (parsed?.content) {
      event.sender.send('agent:stream-chunk', requestId, parsed.content);
      hasContent = true;
    }
  };

  const onError = (error) => {
    const errorMsg = OpenClawResponseParser.extractError(error);
    event.sender.send('agent:stream-error', requestId, errorMsg);
  };

  const isLocal = !agent.sshHost;

  if (isLocal) {
    const { cmd, workDir } = builder.buildLocal();
    await executor.executeStream(agent, cmd, onData, onError);
  } else {
    const cmd = builder.build();
    await executor.executeStream(agent, cmd, onData, onError);
  }

  // If no content was streamed, try parsing the full output
  if (!hasContent && fullOutput) {
    const parsed = OpenClawResponseParser.parse(fullOutput);
    if (parsed?.content) {
      event.sender.send('agent:stream-chunk', requestId, parsed.content);
    }
  }

  event.sender.send('agent:stream-done', requestId, {});
}

/**
 * Ping OpenClaw to check availability
 */
async function pingOpenClaw(agent) {
  const executor = new OpenClawExecutor(15000); // 15 second timeout for ping
  const isLocal = !agent.sshHost;

  // Try status command first, fall back to version
  const commands = [
    'openclaw status --json 2>/dev/null',
    'openclaw --version 2>&1'
  ];

  for (const cmd of commands) {
    let result;

    if (isLocal) {
      result = await executor.executeLocal(cmd, process.env.HOME);
    } else {
      result = await executor.executeSSH(agent, cmd);
    }

    if (result.success && result.output?.trim()) {
      return {
        online: true,
        info: result.output.trim()
      };
    }
  }

  return {
    online: false,
    error: 'OpenClaw not available or not installed'
  };
}

/**
 * Local-specific chat function (for backward compatibility)
 */
async function chatOpenClawLocal(agent, messages) {
  return chatOpenClaw({ ...agent, sshHost: null }, messages);
}

/**
 * Local-specific ping function (for backward compatibility)
 */
async function pingOpenClawLocal(agent) {
  return pingOpenClaw({ ...agent, sshHost: null });
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Main functions
  chatOpenClaw,
  streamOpenClaw,
  pingOpenClaw,

  // Backward compatibility
  chatOpenClawLocal,
  pingOpenClawLocal,

  // Utilities (exposed for testing)
  OpenClawResponseParser,
  OpenClawCommandBuilder,
  OpenClawExecutor,

  // Legacy function for compatibility
  extractOpenClawResponse: (output) => {
    const parsed = OpenClawResponseParser.parse(output);
    return parsed?.content || output.trim();
  }
};