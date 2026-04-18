const { runSSHCommand } = require('./lib/ssh');
const { runLocalCommand } = require('./lib/local');
const { makeRequest } = require('./lib/http');
const { shellQuote, buildRemoteCdCommand } = require('./lib/shell');
const { extractClaudeCodeResponse } = require('./providers/claude-code');
const { chatCodexLocal, chatCodexSSH } = require('./providers/codex');

// Universal local-only commands (always available, handled in renderer)
const LOCAL_COMMANDS = {
  '/clear': { desc: 'Clear chat history' },
  '/status': { desc: 'Check connection status' },
};

// Generic CLI help parser: extracts subcommands/options from --help output
// Handles common formats:
//   command    Description text
//   command  - Description text
//   command — Description text
//   --flag     Description text
function parseCLIHelp(output) {
  const cmds = [];
  const lines = output.split('\n');
  const seen = new Set();
  for (const line of lines) {
    // Match "  subcommand   description" patterns (indented, at least 2 spaces between name and desc)
    const match = line.match(/^\s{1,8}([\w][\w-]*)\s{2,}[-–—:]?\s*(.+)/);
    if (match) {
      const name = '/' + match[1].toLowerCase();
      if (!LOCAL_COMMANDS[name] && !seen.has(name)) {
        seen.add(name);
        cmds.push({ name, desc: match[2].trim() });
      }
    }
  }
  // If we got nothing useful, add a /help fallback
  if (cmds.length === 0) {
    cmds.push({ name: '/help', desc: 'Show help output' });
  }
  return cmds;
}

// How to discover and execute commands for each provider
const PROVIDER_CONFIG = {
  'claude-code': {
    // Static list — no SDK needed, no API call for discovery
    discoverCmd: null,
    execCmd: (agent, slashCmd, arg) => ({
      claudeExec: true,
      agent,
      prompt: `${slashCmd}${arg ? ' ' + arg : ''}`,
    }),
    staticCmds: [
      { name: '/help', desc: 'Show available commands' },
      { name: '/model', desc: 'Switch AI model (e.g. /model sonnet)' },
      { name: '/fast', desc: 'Toggle fast output mode' },
      { name: '/permissions', desc: 'View or update permissions' },
      { name: '/memory', desc: 'View or manage memory files' },
      { name: '/config', desc: 'Open or edit configuration' },
      { name: '/doctor', desc: 'Check environment and diagnose issues' },
      { name: '/login', desc: 'Sign in to your account' },
      { name: '/logout', desc: 'Sign out of your account' },
      { name: '/bug', desc: 'Report a bug' },
      { name: '/vim', desc: 'Toggle vim keybindings' },
      { name: '/compact', desc: 'Compact conversation context' },
      { name: '/cost', desc: 'Show token and cost usage' },
      { name: '/init', desc: 'Initialize CLAUDE.md project file' },
      { name: '/mcp', desc: 'Show MCP server status' },
      { name: '/review', desc: 'Review code changes' },
      { name: '/skills', desc: 'Manage local workflow skills' },
    ],
    parseHelp: () => [],
  },
  'openclaw': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'openclaw --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => ({ ssh: true, agent, command: `openclaw ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` }),
    parseHelp: parseCLIHelp,
  },
  'openclaw-local': {
    discoverCmd: (agent) => ({ local: true, command: 'openclaw --help 2>&1', cwd: agent.workDir }),
    execCmd: (agent, slashCmd, arg) => ({ local: true, command: `openclaw ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir }),
    parseHelp: parseCLIHelp,
  },
  'hermes': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'hermes --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => ({ ssh: true, agent, command: `hermes ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` }),
    parseHelp: parseCLIHelp,
  },
  'hermes-local': {
    discoverCmd: (agent) => ({ local: true, command: 'hermes --help 2>&1', cwd: agent.workDir }),
    execCmd: (agent, slashCmd, arg) => ({ local: true, command: `hermes ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir }),
    parseHelp: parseCLIHelp,
  },
  'openai-compat': {
    // OpenAI-compat has no CLI, provide a static /models command via special handling
    discoverCmd: null,
    execCmd: (agent, slashCmd, arg) => {
      if (slashCmd === '/models') return { http: true, url: `${agent.baseUrl}/v1/models`, apiKey: agent.apiKey };
      return null;
    },
    staticCmds: [{ name: '/models', desc: 'List available models' }],
    parseHelp: () => [],
  },
  'codex': {
    discoverCmd: (agent) => ({ local: true, command: `${agent.codexPath || 'codex'} --help 2>&1`, cwd: agent.workDir }),
    execCmd: (agent, slashCmd, arg) => {
      if (slashCmd === '/plan') return { codexPlan: true, agent, arg };
      return { local: true, command: `${agent.codexPath || 'codex'} ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1`, cwd: agent.workDir };
    },
    staticCmds: [{ name: '/plan', desc: 'Ask Codex for an implementation plan before editing' }],
    parseHelp: parseCLIHelp,
  },
  'codex-ssh': {
    discoverCmd: (agent) => {
      const workDir = agent.workDir || '~';
      return { ssh: true, agent, command: `${buildRemoteCdCommand(workDir)} && codex --help 2>&1` };
    },
    execCmd: (agent, slashCmd, arg) => {
      const workDir = agent.workDir || '~';
      if (slashCmd === '/plan') return { codexPlan: true, agent, arg };
      return { ssh: true, agent, command: `${buildRemoteCdCommand(workDir)} && codex ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` };
    },
    staticCmds: [{ name: '/plan', desc: 'Ask Codex for an implementation plan before editing' }],
    parseHelp: parseCLIHelp,
  },
  'claude-code-ssh': {
    discoverCmd: (agent) => ({ ssh: true, agent, command: 'claude --help 2>&1' }),
    execCmd: (agent, slashCmd, arg) => {
      const workDir = agent.workDir || '~';
      return { ssh: true, agent, command: `cd ${workDir} && claude ${slashCmd.slice(1)}${arg ? ' ' + arg : ''} 2>&1` };
    },
    parseHelp: (output) => {
      // Parse Claude Code help output
      const cmds = [];
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(\/\w[\w-]*)\s+[-–—:]?\s*(.+)/);
        if (match) {
          const name = match[1].toLowerCase();
          if (!LOCAL_COMMANDS[name]) {
            cmds.push({ name, desc: match[2].trim() });
          }
        }
      }
      // Add common Claude Code commands if not found
      if (cmds.length === 0) {
        cmds.push(
          { name: '/help', desc: 'Show available commands' },
          { name: '/status', desc: 'Show session status' },
          { name: '/clear', desc: 'Clear conversation' },
          { name: '/skills', desc: 'Manage local workflow skills' }
        );
      }

      // Always ensure /skills is available even if not in help output
      if (!cmds.find(c => c.name === '/skills')) {
        cmds.push({ name: '/skills', desc: 'Manage local workflow skills' });
      }
      return cmds;
    },
  },
};

// Cache discovered commands: key = provider + agent-id, value = { commands, timestamp }
const discoveredCommandsCache = new Map();
const DISCOVERY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function discoverCommands(agent) {
  const provider = agent.provider;
  const config = PROVIDER_CONFIG[provider];
  if (!config) return [];

  const cacheKey = `${provider}:${agent.id || 'default'}`;
  const cached = discoveredCommandsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < DISCOVERY_CACHE_TTL) {
    return cached.commands;
  }

  // Start with local commands
  let commands = Object.entries(LOCAL_COMMANDS).map(([name, info]) => ({ name, desc: info.desc }));

  // Add static commands if any
  if (config.staticCmds) {
    commands = commands.concat(config.staticCmds);
  }

  // Discover dynamic commands from the CLI
  if (config.discoverCmd) {
    try {
      const spec = await config.discoverCmd(agent);
      let output = '';

      if (spec.cli) {
        output = await runLocalCommand(spec.cli, spec.args, { cwd: spec.cwd || process.env.HOME, timeout: 15000 });
      } else if (spec.ssh) {
        output = await runSSHCommand(spec.agent || agent, spec.command, 15000);
      } else if (spec.local) {
        output = await runLocalCommand('bash', ['-l', '-c', spec.command], { cwd: spec.cwd || agent.workDir || process.env.HOME, timeout: 15000 });
      }

      if (output) {
        const parsed = config.parseHelp(output);
        // Merge discovered commands (don't duplicate locals)
        const existingNames = new Set(commands.map(c => c.name));
        for (const cmd of parsed) {
          if (!existingNames.has(cmd.name)) {
            commands.push(cmd);
          }
        }
      }
    } catch (err) {
      console.error(`Command discovery failed for ${provider}:`, err.message);
      // Fall through with just local commands
    }
  }

  discoveredCommandsCache.set(cacheKey, { commands, timestamp: Date.now() });
  return commands;
}

function registerSlashCommandHandlers(ipcMain) {
  ipcMain.handle('agent:slash-commands', async (_event, provider) => {
    // Lightweight version: return cached or local-only commands
    const cacheKey = `${provider}:default`;
    const cached = discoveredCommandsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < DISCOVERY_CACHE_TTL) {
      return cached.commands;
    }
    const config = PROVIDER_CONFIG[provider] || {};
    const commands = Object.entries(LOCAL_COMMANDS).map(([name, info]) => ({ name, desc: info.desc }));
    if (config.staticCmds) commands.push(...config.staticCmds);
    return commands;
  });

  // Full discovery: pass the agent object to discover commands from the CLI
  ipcMain.handle('agent:discover-slash-commands', async (_event, agent) => {
    const commands = await discoverCommands(agent);
    // Also cache under the default key so getSlashCommands returns them
    const defaultKey = `${agent.provider}:default`;
    discoveredCommandsCache.set(defaultKey, { commands, timestamp: Date.now() });
    return commands;
  });

  ipcMain.handle('agent:exec-slash', async (_event, agent, command) => {
    const parts = command.trim().split(/\s+/);
    const slashCmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');
    const provider = agent.provider;

    // Local-only commands (clear, status) are handled in the renderer
    if (LOCAL_COMMANDS[slashCmd]) {
      return { local: true, command: slashCmd };
    }

    const config = PROVIDER_CONFIG[provider];
    if (!config) {
      return { error: `Unknown provider: ${provider}` };
    }

    // If this is /help, also trigger a fresh discovery for the command palette
    if (slashCmd === '/help' && config.discoverCmd) {
      // Invalidate cache so next palette open gets fresh commands
      discoveredCommandsCache.delete(`${provider}:${agent.id || 'default'}`);
      discoveredCommandsCache.delete(`${provider}:default`);
    }

    try {
      const spec = config.execCmd(agent, slashCmd, arg);
      if (!spec) {
        return { error: `Unknown command: ${slashCmd}. Type / to see available commands.` };
      }

      // Codex does not expose plan mode as a CLI subcommand. Treat /plan as a
      // planning prompt so the slash palette can offer the workflow without
      // running `codex plan`.
      if (spec.codexPlan) {
        if (!arg) {
          return { content: 'Usage: /plan <what you want Codex to plan>' };
        }

        const planPrompt = [
          'Plan mode: create a concise implementation plan for the request below.',
          'Do not edit files or run commands that change state. Ask clarifying questions if the request is underspecified.',
          '',
          arg,
        ].join('\n');

        if (provider === 'codex') {
          return await chatCodexLocal(agent, [{ role: 'user', content: planPrompt }]);
        }
        if (provider === 'codex-ssh') {
          return await chatCodexSSH(agent, [{ role: 'user', content: planPrompt }]);
        }
      }

      // Claude Code slash command via CLI
      if (spec.claudeExec) {
        const claudePath = spec.agent.claudePath || 'claude';
        const cwd = spec.agent.workDir || process.env.HOME;
        try {
          const output = await runLocalCommand(claudePath, ['-p', '--output-format', 'json', spec.prompt], { cwd, timeout: 60000 });
          try {
            const data = JSON.parse(output);
            return { content: data.result || data.text || output.trim(), sessionId: data.session_id };
          } catch {
            return { content: extractClaudeCodeResponse(output) };
          }
        } catch (err) {
          return { error: err.message };
        }
      }

      // SSH command
      if (spec.ssh) {
        const output = await runSSHCommand(spec.agent || agent, spec.command, 30000);
        return { content: output.trim() };
      }

      // Local shell command
      if (spec.local) {
        const output = await runLocalCommand('bash', ['-l', '-c', spec.command], { cwd: spec.cwd || agent.workDir || process.env.HOME, timeout: 30000 });
        return { content: output.trim() };
      }

      // Legacy CLI command (non-Claude-Code providers)
      if (spec.cli) {
        const output = await runLocalCommand(spec.cli, spec.args, { cwd: spec.cwd || process.env.HOME, timeout: 30000 });
        discoverCommands(agent).catch(() => {});
        return { content: extractClaudeCodeResponse(output) };
      }

      // HTTP request (openai-compat models list)
      if (spec.http) {
        const headers = {};
        if (spec.apiKey) headers['Authorization'] = `Bearer ${spec.apiKey}`;
        const res = await makeRequest(spec.url, { method: 'GET', headers });
        try {
          const data = JSON.parse(res.body);
          if (data.data) {
            const modelNames = data.data.map(m => m.id).join('\n');
            return { content: `Available models:\n${modelNames}` };
          }
          return { content: res.body };
        } catch {
          return { content: res.body };
        }
      }

      return { error: 'Could not execute command' };
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = { registerSlashCommandHandlers };
