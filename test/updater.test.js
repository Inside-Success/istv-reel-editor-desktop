"use strict";

/**
 * Unit test for the auto-update wiring (src/main/updater.js) with `electron`
 * and `electron-updater` stubbed, so it runs under plain Node — no packaged
 * build, no network, no real Squirrel. It verifies:
 *   - IPC handlers register on the right channels
 *   - a dev (non-packaged) check reports "not-available", never throws
 *   - a packaged check drives autoUpdater and forwards its events verbatim
 *   - download / install / open-releases delegate correctly
 */

const assert = require("assert");
const Module = require("module");
const path = require("path");
const { EventEmitter } = require("events");

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log("  ok - " + name);
  passed++;
}

// ── Build stubs ───────────────────────────────────────────────────────────────
function makeStubs({ isPackaged }) {
  const sent = []; // messages sent to the renderer
  const ipcHandlers = {}; // channel → handler
  const webContents = { send: (ch, payload) => sent.push({ ch, payload }) };
  const win = { isDestroyed: () => false, webContents };

  const electron = {
    app: {
      isPackaged,
      getVersion: () => "0.1.2",
    },
    ipcMain: {
      handle: (ch, fn) => {
        ipcHandlers[ch] = fn;
      },
    },
    shell: { openExternal: (url) => sent.push({ ch: "shell:open", payload: url }) },
  };

  const autoUpdater = new EventEmitter();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.checkForUpdates = async () => {
    autoUpdater._checked = true;
  };
  autoUpdater.downloadUpdate = async () => {
    autoUpdater._downloaded = true;
  };
  autoUpdater.quitAndInstall = (silent, forceRun) => {
    autoUpdater._installed = { silent, forceRun };
  };

  return { electron, autoUpdater, sent, ipcHandlers, win };
}

// Patch Module._load once for the whole test. `electron` and `electron-updater`
// resolve to whatever `activeStubs` points at — set per case. This must stay
// patched across the async IPC calls, because updater.js requires
// electron-updater lazily (at check time), not at load time.
let activeStubs = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (activeStubs) {
    if (request === "electron") return activeStubs.electron;
    if (request === "electron-updater") return { autoUpdater: activeStubs.autoUpdater };
  }
  return origLoad.call(this, request, parent, isMain);
};

/** Load a *fresh* copy of updater.js with the given stubs active, so state
 *  (busy/wired) doesn't leak between cases. */
function loadUpdater(stubs) {
  activeStubs = stubs;
  const updaterPath = require.resolve("../src/main/updater.js");
  delete require.cache[updaterPath];
  return require(updaterPath);
}

const C = require("../src/main/channels.js");

// ── Case 1: dev build (not packaged) ────────────────────────────────────────────
(async () => {
  console.log("updater: dev build (not packaged)");
  const stubs = makeStubs({ isPackaged: false });
  const updater = loadUpdater(stubs);
  updater.initUpdater(() => stubs.win);

  ok(typeof stubs.ipcHandlers[C.UPDATE_CHECK] === "function", "registers UPDATE_CHECK handler");
  ok(typeof stubs.ipcHandlers[C.UPDATE_DOWNLOAD] === "function", "registers UPDATE_DOWNLOAD handler");
  ok(typeof stubs.ipcHandlers[C.UPDATE_INSTALL] === "function", "registers UPDATE_INSTALL handler");
  ok(
    typeof stubs.ipcHandlers[C.UPDATE_OPEN_RELEASES] === "function",
    "registers UPDATE_OPEN_RELEASES handler"
  );

  // Manual check in dev must report not-available (with dev flag), never touch autoUpdater.
  await stubs.ipcHandlers[C.UPDATE_CHECK]();
  const evt = stubs.sent.find((s) => s.ch === C.UPDATE_EVENT);
  ok(evt && evt.payload.status === "not-available", "dev check emits not-available");
  ok(evt.payload.dev === true, "dev check flags dev=true");
  ok(stubs.autoUpdater._checked !== true, "dev check does NOT call autoUpdater.checkForUpdates");

  // Download / install are no-ops in dev (nothing to install).
  await stubs.ipcHandlers[C.UPDATE_DOWNLOAD]();
  ok(stubs.autoUpdater._downloaded !== true, "dev download is a no-op");
  await stubs.ipcHandlers[C.UPDATE_INSTALL]();
  ok(stubs.autoUpdater._installed === undefined, "dev install is a no-op");

  // ── Case 2: packaged build ────────────────────────────────────────────────────
  console.log("updater: packaged build");
  const p = makeStubs({ isPackaged: true });
  const updater2 = loadUpdater(p);
  updater2.initUpdater(() => p.win);

  await p.ipcHandlers[C.UPDATE_CHECK]();
  ok(p.autoUpdater._checked === true, "packaged check calls autoUpdater.checkForUpdates");
  ok(p.autoUpdater.autoDownload === false, "autoDownload disabled (UI drives download)");
  ok(p.autoUpdater.autoInstallOnAppQuit === true, "autoInstallOnAppQuit enabled");

  // Forwarded events: available → download-progress → downloaded.
  p.sent.length = 0;
  p.autoUpdater.emit("update-available", { version: "0.2.0" });
  p.autoUpdater.emit("download-progress", { percent: 42, transferred: 42, total: 100 });
  p.autoUpdater.emit("update-downloaded", { version: "0.2.0" });

  const statuses = p.sent.filter((s) => s.ch === C.UPDATE_EVENT).map((s) => s.payload.status);
  ok(statuses.includes("available"), "forwards update-available");
  ok(statuses.includes("download-progress"), "forwards download-progress");
  ok(statuses.includes("downloaded"), "forwards update-downloaded");

  const avail = p.sent.find((s) => s.payload && s.payload.status === "available");
  ok(avail.payload.version === "0.2.0", "available event carries version");
  const prog = p.sent.find((s) => s.payload && s.payload.status === "download-progress");
  ok(Math.abs(prog.payload.percent - 0.42) < 1e-9, "progress percent normalized to 0..1");

  // error event forwarding
  p.sent.length = 0;
  p.autoUpdater.emit("error", new Error("boom"));
  const err = p.sent.find((s) => s.payload && s.payload.status === "error");
  ok(err && err.payload.message === "boom", "forwards error message");

  // download + install delegate
  await p.ipcHandlers[C.UPDATE_DOWNLOAD]();
  ok(p.autoUpdater._downloaded === true, "packaged download calls autoUpdater.downloadUpdate");
  await p.ipcHandlers[C.UPDATE_INSTALL]();
  ok(
    p.autoUpdater._installed && p.autoUpdater._installed.forceRun === true,
    "install calls quitAndInstall(false, true)"
  );

  // open-releases delegates to shell
  await p.ipcHandlers[C.UPDATE_OPEN_RELEASES]();
  ok(
    p.sent.some((s) => s.ch === "shell:open" && /github\.com/.test(s.payload)),
    "open-releases opens the GitHub releases URL"
  );

  Module._load = origLoad; // restore
  console.log(`\nALL ${passed} UPDATER TESTS PASSED`);
})().catch((e) => {
  Module._load = origLoad;
  console.error("\nUPDATER TEST FAILED:", e.message);
  process.exit(1);
});
