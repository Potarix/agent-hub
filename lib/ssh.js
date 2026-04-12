const { spawn } = require('child_process');

function runSSHCommand(agent, command, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const sshUser = agent.sshUser || 'root';
    const sshHost = agent.sshHost;
    const sshPort = agent.sshPort || 22;
    const sshKey = agent.sshKey || '';

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ConnectTimeout=10`,
      '-p', String(sshPort),
    ];
    if (sshKey) args.push('-i', sshKey);
    const wrappedCommand = `bash -l -c ${JSON.stringify(command)}`;
    args.push(`${sshUser}@${sshHost}`, wrappedCommand);

    const proc = spawn('ssh', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let timer = setTimeout(() => {
      proc.kill();
      reject(new Error('SSH command timeout'));
    }, timeout);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { proc.kill(); reject(new Error('SSH command timeout')); }, timeout);
    };

    proc.stdout.on('data', resetTimer);
    proc.stderr.on('data', resetTimer);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const combined = stdout + '\n' + stderr;
      if (stdout.trim() || combined.includes('payloads')) {
        resolve(combined);
      } else if (code === 0) {
        resolve(stdout);
      } else if (code === 255) {
        reject(new Error(`SSH connection failed: ${stderr.trim() || 'Could not connect to host'}`));
      } else {
        reject(new Error(stderr.trim() || `Command exited with code ${code}`));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function streamSSHCommand(agent, command, event, requestId, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const sshUser = agent.sshUser || 'root';
    const sshHost = agent.sshHost;
    const sshPort = agent.sshPort || 22;
    const sshKey = agent.sshKey || '';

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ConnectTimeout=10`,
      '-p', String(sshPort),
    ];
    if (sshKey) args.push('-i', sshKey);
    const wrappedCommand = `bash -l -c ${JSON.stringify(command)}`;
    args.push(`${sshUser}@${sshHost}`, wrappedCommand);

    const proc = spawn('ssh', args);
    let fullOutput = '';
    let stderrOutput = '';
    let sawStdout = false;
    let settled = false;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      sawStdout = true;
      fullOutput += text;
      event.sender.send('agent:stream-chunk', requestId, text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('Warning:') && !text.includes('Permanently added')) {
        stderrOutput += text;
        fullOutput += text;
      }
    });

    let timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      event.sender.send('agent:stream-error', requestId, 'SSH command timeout');
      resolve(fullOutput);
    }, timeout);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        event.sender.send('agent:stream-error', requestId, 'SSH command timeout');
        resolve(fullOutput);
      }, timeout);
    };

    proc.stdout.on('data', resetTimer);
    proc.stderr.on('data', resetTimer);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !sawStdout) {
        event.sender.send('agent:stream-error', requestId, stderrOutput.trim() || `SSH command exited with code ${code}`);
      } else {
        event.sender.send('agent:stream-done', requestId, {});
      }
      resolve(fullOutput);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      event.sender.send('agent:stream-error', requestId, err.message);
      reject(err);
    });
  });
}

module.exports = { runSSHCommand, streamSSHCommand };
