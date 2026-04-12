const { spawn, execSync } = require('child_process');

let _loginEnv = null;
function getLoginEnv() {
  if (_loginEnv) return _loginEnv;
  try {
    const raw = execSync('/bin/bash -l -c env', { timeout: 5000, encoding: 'utf-8' });
    const env = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
    }
    _loginEnv = env;
  } catch {
    _loginEnv = process.env;
  }
  return _loginEnv;
}

function runLocalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...getLoginEnv(), ...(options.env || {}) },
      cwd: options.cwd || process.env.HOME,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = options.timeout || 300000;
    let timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Command timeout'));
    }, timeout);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { proc.kill(); reject(new Error('Command timeout')); }, timeout);
    };

    proc.stdout.on('data', resetTimer);
    proc.stderr.on('data', resetTimer);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        resolve(stdout);
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

module.exports = { getLoginEnv, runLocalCommand };
