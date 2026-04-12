const { spawn } = require('child_process');
const { shell } = require('electron');
const { getLoginEnv, runLocalCommand } = require('./lib/local');
const { getMainWindow } = require('./lib/state');

const authProcesses = {};

function registerAuthHandlers(ipcMain) {
  ipcMain.handle('agent:auth-login', async (_event, agent) => {
    try {
      if (agent.provider === 'claude-code') {
        const claudePath = agent.claudePath || 'claude';

        if (authProcesses[agent.id]) {
          try { authProcesses[agent.id].kill(); } catch {}
          delete authProcesses[agent.id];
        }

        const proc = spawn(claudePath, ['auth', 'login'], {
          env: getLoginEnv(),
          cwd: agent.workDir || process.env.HOME,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let urlOpened = false;
        const mainWindow = getMainWindow();

        const sendStatus = (status) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:auth-status', agent.id, status);
          }
        };

        const handleData = (chunk) => {
          const text = chunk.toString();
          output += text;

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:auth-output', agent.id, text);
          }

          if (!urlOpened) {
            const urlMatch = output.match(/(https?:\/\/[^\s]+)/);
            if (urlMatch) {
              urlOpened = true;
              shell.openExternal(urlMatch[1]);
              sendStatus('waiting-for-code');
            }
          }

          const lower = text.toLowerCase();
          if (lower.includes('success') || lower.includes('logged in') || lower.includes('authenticated')) {
            sendStatus('authenticated');
          }
        };

        proc.stdout.on('data', handleData);
        proc.stderr.on('data', handleData);

        const timer = setTimeout(() => {
          proc.kill();
          delete authProcesses[agent.id];
          sendStatus('error');
        }, 180000);

        proc.on('close', (code) => {
          clearTimeout(timer);
          delete authProcesses[agent.id];

          const lower = output.toLowerCase();
          if (code === 0 || lower.includes('success') || lower.includes('logged in') || lower.includes('authenticated')) {
            sendStatus('authenticated');
          } else {
            sendStatus('error');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('agent:auth-output', agent.id, output.trim() || `Auth exited with code ${code}`);
            }
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          delete authProcesses[agent.id];
          sendStatus('error');
        });

        authProcesses[agent.id] = proc;

        return { ok: true, pending: true, message: 'Auth started.' };

      } else if (agent.provider === 'openclaw-local') {
        const output = await runLocalCommand('bash', ['-l', '-c', 'openclaw setup 2>&1'], { timeout: 60000 });
        return { ok: true, message: output.trim() };
      } else if (agent.provider === 'hermes-local') {
        const output = await runLocalCommand('bash', ['-l', '-c', 'hermes setup 2>&1'], { timeout: 60000 });
        return { ok: true, message: output.trim() };
      } else {
        return { error: 'In-app auth not supported for this provider.' };
      }
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('agent:auth-status', async (_event, agent) => {
    try {
      if (agent.provider === 'claude-code') {
        const claudePath = agent.claudePath || 'claude';
        const output = await runLocalCommand(claudePath, ['auth', 'status'], {
          cwd: agent.workDir || process.env.HOME,
          timeout: 10000,
        });
        const text = output.toLowerCase();
        const loggedIn = text.includes('logged in') || text.includes('authenticated') || text.includes('valid');
        return { authenticated: loggedIn, detail: output.trim() };
      }
      return { authenticated: false, detail: 'Unknown provider' };
    } catch (err) {
      return { authenticated: false, detail: err.message };
    }
  });

  ipcMain.handle('agent:auth-send-input', async (_event, agentId, input) => {
    const proc = authProcesses[agentId];
    if (!proc || proc.killed) {
      return { error: 'No auth process running. Click Login to start again.' };
    }
    try {
      proc.stdin.write(input + '\n');
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('agent:open-auth-terminal', async (_event, agent) => {
    return { error: 'Please use the Login button instead.' };
  });
}

module.exports = { registerAuthHandlers };
