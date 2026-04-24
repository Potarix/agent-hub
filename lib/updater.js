const { app, dialog, ipcMain } = require('electron');
const { getMainWindow } = require('./state');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

const state = {
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,
  canInstall: false,
};

function cleanUpdateInfo(info) {
  if (!info) return null;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseName: info.releaseName,
    releaseNotes: info.releaseNotes,
  };
}

function getStatus() {
  return {
    ...state,
    currentVersion: app.getVersion(),
    enabled: Boolean(autoUpdater && app.isPackaged),
    packaged: app.isPackaged,
  };
}

function publishStatus(patch = {}) {
  Object.assign(state, patch);
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', getStatus());
  }
}

function configureUpdater() {
  if (!autoUpdater || configureUpdater.configured) return;
  configureUpdater.configured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    publishStatus({ status: 'checking', error: null, progress: null, canInstall: false });
  });

  autoUpdater.on('update-available', (info) => {
    publishStatus({
      status: 'downloading',
      updateInfo: cleanUpdateInfo(info),
      error: null,
      progress: null,
      canInstall: false,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    publishStatus({
      status: 'current',
      updateInfo: cleanUpdateInfo(info),
      error: null,
      progress: null,
      canInstall: false,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    publishStatus({
      status: 'downloading',
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
      error: null,
      canInstall: false,
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    publishStatus({
      status: 'ready',
      updateInfo: cleanUpdateInfo(info),
      progress: null,
      error: null,
      canInstall: true,
    });

    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;

    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `Agent Hub ${info.version} is ready to install.`,
      detail: 'Restart Agent Hub to finish installing the update.',
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (err) => {
    publishStatus({
      status: 'error',
      error: err?.message || String(err),
      progress: null,
      canInstall: false,
    });
  });
}

async function checkForUpdates() {
  configureUpdater();

  if (!autoUpdater) {
    publishStatus({ status: 'error', error: 'Updater dependency is not installed.' });
    return getStatus();
  }

  if (!app.isPackaged) {
    publishStatus({
      status: 'disabled',
      error: 'Updates are available from packaged builds only.',
      canInstall: false,
    });
    return getStatus();
  }

  await autoUpdater.checkForUpdates();
  return getStatus();
}

function registerUpdaterHandlers() {
  configureUpdater();

  ipcMain.handle('app:get-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('updater:get-status', () => getStatus());
  ipcMain.handle('updater:check', () => checkForUpdates());
  ipcMain.handle('updater:install', () => {
    if (!autoUpdater || !state.canInstall) return { ok: false, error: 'No downloaded update is ready.' };
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
}

function scheduleUpdateCheck() {
  configureUpdater();
  if (!autoUpdater || !app.isPackaged) return;
  setTimeout(() => {
    checkForUpdates().catch(err => {
      publishStatus({ status: 'error', error: err?.message || String(err) });
    });
  }, 15000);
}

module.exports = { registerUpdaterHandlers, scheduleUpdateCheck };
