"use strict";

/**
 * In-app auto-update, so users get new builds from inside the app instead of
 * re-downloading and re-installing every release.
 *
 * How it works: electron-builder already publishes each release to this repo's
 * GitHub Releases (see the `build.publish` block in package.json) and writes
 * the matching `latest.yml` / `latest-mac.yml` metadata + `app-update.yml` into
 * the packaged app. `electron-updater` reads that metadata, compares the
 * released version against the running one, and — when the user asks —
 * downloads the new installer and swaps it in on restart. No server of our own.
 *
 * The release workflow (.github/workflows/release.yml) builds every OS into a
 * single draft release and then flips it to public, so the metadata the updater
 * reads is always for a fully-populated, published release.
 *
 * Platform notes:
 *  - Windows (NSIS): full self-update works out of the box.
 *  - macOS: Squirrel.Mac only self-installs *code-signed* apps. Our mac build
 *    isn't signed yet, so we DON'T attempt a self-install there — the UI detects
 *    the new version and sends the user to the download page instead. Once an
 *    Apple Developer ID is wired in, mac can self-update too (no code change,
 *    just flip the platform gate in the renderer).
 *  - Dev (`npm start`, not packaged): there's no update metadata, so we report
 *    "not available" instead of crashing.
 */

const { app, ipcMain, shell } = require("electron");
const C = require("./channels");

// GitHub Releases page for this app — the manual-download fallback (macOS, or
// if a self-install ever fails).
const RELEASES_URL = "https://github.com/Inside-Success/istv-reel-editor-desktop/releases/latest";

let autoUpdater = null;
let getWindow = () => null;
let wired = false; // guard so autoUpdater listeners are attached only once
let busy = false; // a check or download is in flight

/** Push an update event to the renderer, if a window is alive to receive it. */
function emit(status, payload = {}) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(C.UPDATE_EVENT, { status, ...payload });
  }
}

/**
 * Lazily require + configure electron-updater. Kept lazy so dev runs and the
 * smoke test (which never touch updates) don't pay for loading it, and so a
 * missing/broken dependency can't take down app startup.
 */
function getUpdater() {
  if (autoUpdater) return autoUpdater;
  const { autoUpdater: au } = require("electron-updater");

  // We drive the flow explicitly from the UI: check → user clicks Download →
  // download → user clicks Restart. So don't auto-download on check, but do
  // install a downloaded update on the next quit if the user never clicks.
  au.autoDownload = false;
  au.autoInstallOnAppQuit = true;

  if (!wired) {
    wired = true;
    au.on("checking-for-update", () => emit("checking"));
    au.on("update-available", (info) => {
      busy = false;
      emit("available", { version: info && info.version });
    });
    au.on("update-not-available", (info) => {
      busy = false;
      emit("not-available", { version: info && info.version });
    });
    au.on("error", (err) => {
      busy = false;
      emit("error", { message: (err && (err.message || String(err))) || "Unknown update error" });
    });
    au.on("download-progress", (p) => {
      emit("download-progress", {
        percent: p && p.percent ? p.percent / 100 : 0,
        transferred: p && p.transferred,
        total: p && p.total,
        bytesPerSecond: p && p.bytesPerSecond,
      });
    });
    au.on("update-downloaded", (info) => {
      busy = false;
      emit("downloaded", { version: info && info.version });
    });
  }

  autoUpdater = au;
  return au;
}

/** True only when a real, self-updating packaged build is running. */
function canUpdate() {
  return app.isPackaged;
}

async function checkForUpdates(silent = false) {
  if (!canUpdate()) {
    // Running from source — nothing to update to. Say so plainly (unless this
    // was an automatic background check, which stays quiet).
    if (!silent) {
      emit("not-available", { dev: true, version: app.getVersion() });
    }
    return;
  }
  if (busy) return;
  busy = true;
  try {
    await getUpdater().checkForUpdates();
  } catch (e) {
    busy = false;
    emit("error", { message: e && e.message ? e.message : String(e) });
  }
}

async function downloadUpdate() {
  if (!canUpdate()) return;
  if (busy) return;
  busy = true;
  try {
    await getUpdater().downloadUpdate();
  } catch (e) {
    busy = false;
    emit("error", { message: e && e.message ? e.message : String(e) });
  }
}

function quitAndInstall() {
  if (!canUpdate()) return;
  try {
    // isSilent=false, isForceRunAfter=true → relaunch the app after installing.
    getUpdater().quitAndInstall(false, true);
  } catch (e) {
    emit("error", { message: e && e.message ? e.message : String(e) });
  }
}

function openReleasesPage() {
  shell.openExternal(RELEASES_URL);
}

/**
 * Register IPC handlers and kick off a quiet background check shortly after
 * launch. Call once, after the main window exists.
 */
function initUpdater(getWindowFn) {
  getWindow = getWindowFn || (() => null);

  ipcMain.handle(C.UPDATE_CHECK, () => checkForUpdates(false));
  ipcMain.handle(C.UPDATE_DOWNLOAD, () => downloadUpdate());
  ipcMain.handle(C.UPDATE_INSTALL, () => {
    quitAndInstall();
  });
  ipcMain.handle(C.UPDATE_OPEN_RELEASES, () => openReleasesPage());

  // Give the window a moment to finish loading its listeners, then check
  // quietly in the background. If nothing's newer, the user never sees a thing.
  if (canUpdate()) {
    setTimeout(() => checkForUpdates(true), 4000);
  }
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  RELEASES_URL,
};
