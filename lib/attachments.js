const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { runSSHCommand } = require('./ssh');
const { shellQuote, expandHomeDir } = require('./shell');

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function normalizeMessageFiles(message) {
  if (!Array.isArray(message?.files)) return [];
  return message.files
    .map(file => ({
      name: file.name || path.basename(file.path || '') || 'attachment',
      path: file.path || '',
      mimeType: file.mimeType || '',
      size: Number(file.size) || 0,
      isImage: !!file.isImage,
    }))
    .filter(file => file.path);
}

function safeRemoteName(name, index) {
  const base = path.basename(name || 'attachment');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+$/, '') || 'attachment';
  return `${String(index + 1).padStart(2, '0')}-${cleaned}`;
}

function localFilePath(filePath) {
  const expanded = expandHomeDir(filePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function sshTarget(agent) {
  return `${agent.sshUser || 'root'}@${agent.sshHost}`;
}

function buildScpArgs(agent, sourcePath, remotePath, recursive) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-P', String(agent.sshPort || 22),
  ];
  if (agent.sshKey) args.push('-i', agent.sshKey);
  if (recursive) args.push('-r');
  args.push(sourcePath, `${sshTarget(agent)}:${remotePath}`);
  return args;
}

function copyToRemote(agent, sourcePath, remotePath, recursive) {
  return new Promise((resolve, reject) => {
    const proc = spawn('scp', buildScpArgs(agent, sourcePath, remotePath, recursive));
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Attachment upload timeout'));
    }, 5 * 60 * 1000);

    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `scp exited with code ${code}`));
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getRemoteHome(agent) {
  const output = await runSSHCommand(agent, 'printf %s "$HOME"', 30000);
  return output.trim().split('\n')[0] || '~';
}

async function stageRemoteFiles(agent, files) {
  if (!agent.sshHost) return files.map(file => ({ ...file, availablePath: file.path }));

  const remoteHome = await getRemoteHome(agent);
  const remoteDir = `${remoteHome.replace(/\/$/, '')}/.agent-hub/attachments/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await runSSHCommand(agent, `mkdir -p ${shellQuote(remoteDir)}`, 30000);

  const staged = [];
  for (let i = 0; i < files.length; i++) {
    const sourcePath = localFilePath(files[i].path);
    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch (err) {
      throw new Error(`Attachment not found: ${files[i].path}`);
    }

    const remotePath = `${remoteDir}/${safeRemoteName(files[i].name || sourcePath, i)}`;
    await copyToRemote(agent, sourcePath, remotePath, stat.isDirectory());
    staged.push({
      ...files[i],
      size: stat.isDirectory() ? files[i].size : stat.size,
      isDirectory: stat.isDirectory(),
      remotePath,
      availablePath: remotePath,
    });
  }
  return staged;
}

function appendAttachmentReferences(content, files) {
  if (!files.length) return content || '';
  const base = (content || '').trim() || 'Please use the attached files.';
  const lines = files.map((file, index) => {
    const filePath = file.availablePath || file.remotePath || file.path;
    const details = [
      file.isDirectory ? 'directory' : '',
      file.mimeType,
      formatFileSize(file.size),
    ].filter(Boolean).join(', ');
    return `${index + 1}. ${file.name || path.basename(filePath)}\n   Path: ${filePath}${details ? `\n   Info: ${details}` : ''}`;
  });

  return [
    base,
    '',
    'Attached files:',
    ...lines,
    '',
    'Use the paths above when you need to inspect these attachments.',
  ].join('\n');
}

async function prepareMessagesWithFileAttachments(agent, messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const userIndex = (() => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.role === 'user') return i;
    }
    return -1;
  })();

  if (userIndex < 0) return { messages: list, lastUserMsg: null, files: [] };

  const lastUserMsg = list[userIndex];
  const files = normalizeMessageFiles(lastUserMsg);
  if (files.length === 0) {
    return { messages: list, lastUserMsg, files: [] };
  }

  const stagedFiles = options.remote ? await stageRemoteFiles(agent, files) : files.map(file => ({
    ...file,
    availablePath: localFilePath(file.path),
  }));

  const preparedUserMsg = {
    ...lastUserMsg,
    content: appendAttachmentReferences(lastUserMsg.content, stagedFiles),
    files: stagedFiles,
  };
  const preparedMessages = [...list];
  preparedMessages[userIndex] = preparedUserMsg;

  return {
    messages: preparedMessages,
    lastUserMsg: preparedUserMsg,
    files: stagedFiles,
  };
}

module.exports = {
  appendAttachmentReferences,
  prepareMessagesWithFileAttachments,
};
