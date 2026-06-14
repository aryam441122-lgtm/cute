// CUTE BROWSER — main process
// Lightweight multi-tab browser shell built on Electron's WebContentsView.
// Goals: low RAM, smooth animations (renderer handles motion), session restore,
// downloads/history/bookmarks/settings/extensions all persisted to disk
// (NOT localStorage) inside the user-data folder.

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  dialog,
  shell,
  Menu,
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const crypto = require("node:crypto");
let ElectronChromeExtensions = null;
try { ({ ElectronChromeExtensions } = require("electron-chrome-extensions")); } catch {}

// ---- Paths & persisted state ----------------------------------------------
const USER_DATA = app.getPath("userData");
const DATA_DIR = path.join(USER_DATA, "cute-data");
const EXT_DIR = path.join(DATA_DIR, "extensions");
const FILES = {
  settings: path.join(DATA_DIR, "settings.json"),
  history: path.join(DATA_DIR, "history.json"),
  bookmarks: path.join(DATA_DIR, "bookmarks.json"),
  downloads: path.join(DATA_DIR, "downloads.json"),
  sessionTabs: path.join(DATA_DIR, "session-tabs.json"),
  extensions: path.join(DATA_DIR, "extensions.json"),
  pinnedExtensions: path.join(DATA_DIR, "pinned-extensions.json"),
};

for (const dir of [DATA_DIR, EXT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return fallback; }
};
const writeJSON = (p, data) => {
  try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
};

const SHELL_URL = process.env.CUTE_SHELL || "https://iil.lovable.app";
const DEFAULT_HOMEPAGE = process.env.CUTE_HOMEPAGE || "https://iil.lovable.app";

const DEFAULT_SETTINGS = {
  homepage: DEFAULT_HOMEPAGE,
  searchEngine: "https://www.google.com/search?q=",
  downloadDir: app.getPath("downloads"),
  restoreSession: true,
  theme: "void-dark",
  hardwareAcceleration: true,
  suspendInactiveTabsMinutes: 10,
};

let settings = { ...DEFAULT_SETTINGS, ...readJSON(FILES.settings, {}) };
let history = readJSON(FILES.history, []);
let bookmarks = readJSON(FILES.bookmarks, []);
let downloads = readJSON(FILES.downloads, []);
let installedExtensions = readJSON(FILES.extensions, []); // [{id,name,path}]
let pinnedExtensionIds = readJSON(FILES.pinnedExtensions, []);

if (!settings.hardwareAcceleration) app.disableHardwareAcceleration();

// ---- Tab manager ----------------------------------------------------------
/** @type {Map<string, {id:string,view:WebContentsView,title:string,url:string,favicon:string,loading:boolean,lastActive:number}>} */
const tabs = new Map();
let activeTabId = null;
let mainWindow = null;
let tabsVisible = true;
let chromeExtensions = null;

let CHROME_HEIGHT = 96; // tabs bar + address bar — site can override via IPC

function broadcastTabs() {
  if (!mainWindow) return;
  const list = [...tabs.values()].map((t) => ({
    id: t.id, wcId: t.view.webContents.id, title: t.title, url: t.url, favicon: t.favicon,
    loading: t.loading, active: t.id === activeTabId,
    canGoBack: t.view.webContents.navigationHistory.canGoBack(),
    canGoForward: t.view.webContents.navigationHistory.canGoForward(),
  }));
  mainWindow.webContents.send("tabs:update", { tabs: list, activeId: activeTabId });
  persistSession();
}

function persistSession() {
  if (!settings.restoreSession) return;
  writeJSON(FILES.sessionTabs, {
    activeId: activeTabId,
    tabs: [...tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title })),
  });
}

function layoutActiveView() {
  if (!mainWindow || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const { width, height } = mainWindow.getContentBounds();
  tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT });
}

function attachActive() {
  if (!mainWindow) return;
  // Detach all, attach only active (keeps GPU/paint cost low)
  for (const t of tabs.values()) {
    try { mainWindow.contentView.removeChildView(t.view); } catch {}
  }
  if (!tabsVisible) return; // shell is showing an internal page
  const tab = tabs.get(activeTabId);
  if (tab) {
    mainWindow.contentView.addChildView(tab.view);
    layoutActiveView();
    tab.lastActive = Date.now();
    tab.view.webContents.setBackgroundThrottling(false);
    try { chromeExtensions?.selectTab(tab.view.webContents); } catch {}
  }
}

function createTab(url) {
  const id = crypto.randomUUID();
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
      spellcheck: false,
      session: session.defaultSession,
    },
  });
  const wc = view.webContents;
  const tab = { id, view, title: "New Tab", url: url || settings.homepage, favicon: "", loading: true, lastActive: Date.now() };
  tabs.set(id, tab);

  wc.on("page-title-updated", (_e, title) => { tab.title = title; broadcastTabs(); });
  wc.on("page-favicon-updated", (_e, icons) => { tab.favicon = icons?.[0] || ""; broadcastTabs(); });
  wc.on("did-start-loading", () => { tab.loading = true; broadcastTabs(); });
  wc.on("did-stop-loading", () => { tab.loading = false; broadcastTabs(); });
  wc.on("did-navigate", (_e, u) => { tab.url = u; addHistory(u, tab.title); broadcastTabs(); });
  wc.on("did-navigate-in-page", (_e, u) => { tab.url = u; broadcastTabs(); });
  wc.on("context-menu", (_event, params) => showPageContextMenu(tab, params));
  wc.setWindowOpenHandler(({ url }) => { createTab(url); return { action: "deny" }; });

  wc.loadURL(tab.url);
  activeTabId = id;
  try { chromeExtensions?.addTab(wc, mainWindow); } catch {}
  attachActive();
  broadcastTabs();
  return id;
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  try { chromeExtensions?.removeTab(tab.view.webContents); } catch {}
  try { mainWindow.contentView.removeChildView(tab.view); } catch {}
  try { tab.view.webContents.close(); } catch {}
  tabs.delete(id);
  if (activeTabId === id) {
    const next = [...tabs.keys()].pop();
    activeTabId = next || null;
    if (!next) createTab(settings.homepage);
    else attachActive();
  }
  broadcastTabs();
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  attachActive();
  broadcastTabs();
}

function closeOtherTabs(id) {
  for (const tabId of [...tabs.keys()]) if (tabId !== id) closeTab(tabId);
  activateTab(id);
}

function duplicateTab(id) {
  const tab = tabs.get(id);
  if (tab) return createTab(tab.url);
  return null;
}

function toggleMuteTab(id) {
  const tab = tabs.get(id);
  if (!tab) return false;
  const next = !tab.view.webContents.isAudioMuted();
  tab.view.webContents.setAudioMuted(next);
  broadcastTabs();
  return next;
}

function showPageContextMenu(tab, params) {
  const items = [];
  try {
    const extItems = chromeExtensions?.getContextMenuItems(tab.view.webContents, params) || [];
    if (extItems.length) items.push(...extItems, { type: "separator" });
  } catch {}
  if (params.linkURL) items.push({ label: "فتح الرابط في تبويب جديد", click: () => createTab(params.linkURL) });
  if (params.linkURL) items.push({ label: "نسخ الرابط", click: () => clipboard.writeText(params.linkURL) });
  items.push(
    { label: "رجوع", enabled: tab.view.webContents.navigationHistory.canGoBack(), click: () => tab.view.webContents.navigationHistory.goBack() },
    { label: "تقدم", enabled: tab.view.webContents.navigationHistory.canGoForward(), click: () => tab.view.webContents.navigationHistory.goForward() },
    { label: "تحديث", click: () => tab.view.webContents.reload() },
    { type: "separator" },
    { label: "حفظ لقطة من الصفحة", click: () => saveActiveCapture() },
  );
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

async function saveActiveCapture() {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const img = await tab.view.webContents.capturePage().catch(() => null);
  if (!img) return;
  const r = await dialog.showSaveDialog(mainWindow, {
    title: "حفظ لقطة الصفحة",
    defaultPath: path.join(app.getPath("pictures"), `cute-capture-${Date.now()}.png`),
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!r.canceled && r.filePath) await fsp.writeFile(r.filePath, img.toPNG()).catch(() => {});
}

// Suspend inactive tabs to save RAM
setInterval(() => {
  const ms = (settings.suspendInactiveTabsMinutes || 10) * 60 * 1000;
  for (const t of tabs.values()) {
    if (t.id !== activeTabId && Date.now() - t.lastActive > ms) {
      try { t.view.webContents.setBackgroundThrottling(true); } catch {}
    }
  }
}, 60 * 1000);

// ---- History --------------------------------------------------------------
function addHistory(url, title) {
  if (!url || url.startsWith("about:") || url.startsWith("chrome-error://")) return;
  history.unshift({ id: crypto.randomUUID(), url, title, time: Date.now() });
  if (history.length > 5000) history.length = 5000;
  writeJSON(FILES.history, history);
}

// ---- Downloads ------------------------------------------------------------
function wireDownloads(sess) {
  sess.on("will-download", (_event, item) => {
    const savePath = path.join(settings.downloadDir, item.getFilename());
    item.setSavePath(savePath);
    const id = crypto.randomUUID();
    const record = {
      id, url: item.getURL(), filename: item.getFilename(),
      path: savePath, totalBytes: item.getTotalBytes(), receivedBytes: 0,
      state: "progressing", startedAt: Date.now(),
    };
    downloads.unshift(record);
    writeJSON(FILES.downloads, downloads);
    mainWindow?.webContents.send("downloads:update", downloads);

    item.on("updated", (_e, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.state = state;
      mainWindow?.webContents.send("downloads:update", downloads);
    });
    item.once("done", (_e, state) => {
      record.state = state;
      writeJSON(FILES.downloads, downloads);
      mainWindow?.webContents.send("downloads:update", downloads);
    });
  });
}

// ---- Extensions -----------------------------------------------------------
async function loadPersistedExtensions() {
  for (const ext of installedExtensions) {
    try {
      if (fs.existsSync(ext.path)) {
        await session.defaultSession.loadExtension(ext.path, { allowFileAccess: true });
      }
    } catch (e) { console.warn("ext load failed", ext, e); }
  }
}

async function installExtensionFromFolder(folder) {
  // Copy folder into EXT_DIR for stability, then loadExtension
  const id = crypto.randomUUID();
  const dest = path.join(EXT_DIR, id);
  await fsp.cp(folder, dest, { recursive: true });
  try {
    const loaded = await session.defaultSession.loadExtension(dest, { allowFileAccess: true });
    const record = { id: loaded.id, name: loaded.name, path: dest };
    // Avoid duplicates (same chrome ext id)
    if (!installedExtensions.find((x) => x.id === loaded.id)) {
      installedExtensions.push(record);
      writeJSON(FILES.extensions, installedExtensions);
    }
    return record;
  } catch (e) {
    // Roll back the copy so we don't leak orphan folders.
    try { await fsp.rm(dest, { recursive: true, force: true }); } catch {}
    throw e;
  }
}


// Auto-import every extension from the user's installed Chrome on first launch.
// Re-scans on each launch and only copies extensions we haven't already imported
// (tracked by chromeExtId stored on the record).
async function autoImportChromeExtensions() {
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [
        path.join(home, "AppData/Local/Google/Chrome/User Data/Default/Extensions"),
        path.join(home, "AppData/Local/Microsoft/Edge/User Data/Default/Extensions"),
      ]
    : process.platform === "darwin"
    ? [path.join(home, "Library/Application Support/Google/Chrome/Default/Extensions")]
    : [
        path.join(home, ".config/google-chrome/Default/Extensions"),
        path.join(home, ".config/chromium/Default/Extensions"),
      ];
  const root = candidates.find((p) => fs.existsSync(p));
  if (!root) return;

  const alreadyImported = new Set(installedExtensions.map((e) => e.chromeExtId).filter(Boolean));
  let extDirs = [];
  try { extDirs = await fsp.readdir(root); } catch { return; }

  for (const chromeExtId of extDirs) {
    if (alreadyImported.has(chromeExtId)) continue;
    const extRoot = path.join(root, chromeExtId);
    let versions = [];
    try { versions = (await fsp.readdir(extRoot)).filter((v) => !v.startsWith(".")); } catch { continue; }
    if (!versions.length) continue;
    // pick the highest version folder
    versions.sort();
    const latest = versions[versions.length - 1];
    const src = path.join(extRoot, latest);
    if (!fs.existsSync(path.join(src, "manifest.json"))) continue;

    try {
      const localId = crypto.randomUUID();
      const dest = path.join(EXT_DIR, localId);
      await fsp.cp(src, dest, { recursive: true });
      const loaded = await session.defaultSession.loadExtension(dest, { allowFileAccess: true });
      installedExtensions.push({ id: loaded.id, name: loaded.name, path: dest, chromeExtId });
      console.log("Imported Chrome extension:", loaded.name);
    } catch (e) {
      // Many MV3 extensions or DRM-restricted ones may fail — skip silently
      console.warn("Skip extension", chromeExtId, e?.message);
    }
  }
  writeJSON(FILES.extensions, installedExtensions);
}


// ---- Window ---------------------------------------------------------------
function initChromeExtensions() {
  if (!ElectronChromeExtensions || chromeExtensions) return;
  try {
    try { ElectronChromeExtensions.handleCRXProtocol(session.defaultSession); } catch {}
    chromeExtensions = new ElectronChromeExtensions({
      session: session.defaultSession,
      license: "GPL-3.0",
      createTab: async (details) => {
        const previousActive = activeTabId;
        const id = createTab(details.url || settings.homepage);
        if (details.active === false && previousActive && tabs.has(previousActive)) activateTab(previousActive);
        const tab = tabs.get(id);
        return [tab.view.webContents, mainWindow];
      },
      createWindow: async (details) => {
        const urls = Array.isArray(details.url) ? details.url : [details.url || settings.homepage];
        urls.filter(Boolean).forEach((u) => createTab(u));
        return mainWindow;
      },
      selectTab: (wc) => {
        for (const [id, t] of tabs) if (t.view.webContents === wc) { activateTab(id); break; }
      },
      removeTab: (wc) => {
        for (const [id, t] of tabs) if (t.view.webContents === wc) { closeTab(id); break; }
      },
      assignTabDetails: (details, wc) => {
        for (const t of tabs.values()) if (t.view.webContents === wc) {
          details.title = t.title; details.url = t.url; details.favIconUrl = t.favicon;
          details.active = t.id === activeTabId;
        }
      },
    });
  } catch (e) { console.warn("ChromeExtensions init failed:", e?.message); }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: "#0a0a0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "darwin" ? false : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadURL(SHELL_URL);
  mainWindow.on("resize", layoutActiveView);
  mainWindow.on("close", persistSession);

  Menu.setApplicationMenu(null);

  // Session restore — wait for the site to signal it's ready (it knows its own chrome height)
  ipcMain.handleOnce("shell:ready", async (_e, payload) => {
    if (typeof payload?.chromeHeight === "number") CHROME_HEIGHT = payload.chromeHeight;
    initChromeExtensions();
    await autoImportChromeExtensions();
    await loadPersistedExtensions();
    const sess = readJSON(FILES.sessionTabs, null);
    if (settings.restoreSession && sess?.tabs?.length) {
      for (const t of sess.tabs) createTab(t.url);
      const last = [...tabs.values()].at(-1);
      if (last) activateTab(last.id);
    } else {
      createTab(settings.homepage);
    }
    // Register all existing tabs with chrome.tabs API
    if (chromeExtensions) {
      for (const t of tabs.values()) {
        try { chromeExtensions.addTab(t.view.webContents, mainWindow); } catch {}
      }
      const at = tabs.get(activeTabId);
      if (at) try { chromeExtensions.selectTab(at.view.webContents); } catch {}
    }
    return true;
  });
}

// Allow the site to update chrome height live (e.g. when toggling tab bar)
ipcMain.handle("shell:setChromeHeight", (_e, h) => {
  if (typeof h === "number" && h >= 0) { CHROME_HEIGHT = h; layoutActiveView(); }
});

// Show/hide the active tab's WebContentsView. When the user opens an internal
// page (bookmarks, settings, history, downloads, extensions), the shell renders
// that page itself — we detach the tab view so it doesn't cover the shell content.
ipcMain.handle("shell:setTabsVisible", (_e, visible) => {
  tabsVisible = !!visible;
  if (!mainWindow) return;
  if (tabsVisible) {
    attachActive();
  } else {
    for (const t of tabs.values()) {
      try { mainWindow.contentView.removeChildView(t.view); } catch {}
    }
  }
});

// Window controls so the site can render its own min/max/close buttons
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:maximizeToggle", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());

// ---- IPC handlers ---------------------------------------------------------
ipcMain.handle("tabs:list", () => [...tabs.values()].map((t) => ({
  id: t.id, wcId: t.view.webContents.id, title: t.title, url: t.url, favicon: t.favicon,
  loading: t.loading, active: t.id === activeTabId,
  canGoBack: t.view.webContents.navigationHistory.canGoBack(),
  canGoForward: t.view.webContents.navigationHistory.canGoForward(),
})));
ipcMain.handle("tabs:create", (_e, url) => createTab(url));
ipcMain.handle("tabs:close", (_e, id) => closeTab(id));
ipcMain.handle("tabs:closeOthers", (_e, id) => closeOtherTabs(id));
ipcMain.handle("tabs:duplicate", (_e, id) => duplicateTab(id));
ipcMain.handle("tabs:muteToggle", (_e, id) => toggleMuteTab(id));
ipcMain.handle("tabs:activate", (_e, id) => activateTab(id));
ipcMain.handle("tabs:reorder", (_e, ids) => {
  const m = new Map();
  for (const id of ids) if (tabs.has(id)) m.set(id, tabs.get(id));
  for (const [k, v] of tabs) if (!m.has(k)) m.set(k, v);
  tabs.clear(); for (const [k, v] of m) tabs.set(k, v);
  broadcastTabs();
});
ipcMain.handle("tabs:navigate", (_e, id, url) => {
  const tab = tabs.get(id); if (!tab) return;
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return; // empty input → do nothing
  let target = trimmed;
  try { new URL(trimmed); } catch {
    target = /\s/.test(trimmed) || !trimmed.includes(".")
      ? settings.searchEngine + encodeURIComponent(trimmed)
      : "https://" + trimmed;
  }
  tab.view.webContents.loadURL(target);
});
ipcMain.handle("tabs:back", (_e, id) => tabs.get(id)?.view.webContents.navigationHistory.goBack());
ipcMain.handle("tabs:forward", (_e, id) => tabs.get(id)?.view.webContents.navigationHistory.goForward());
ipcMain.handle("tabs:reload", (_e, id) => tabs.get(id)?.view.webContents.reload());
ipcMain.handle("tabs:copyUrl", (_e, id) => {
  const tab = tabs.get(id);
  if (tab) clipboard.writeText(tab.url || "");
});

ipcMain.handle("downloads:list", () => downloads);
ipcMain.handle("downloads:open", (_e, id) => { const d = downloads.find((x) => x.id === id); if (d) shell.openPath(d.path); });
ipcMain.handle("downloads:reveal", (_e, id) => { const d = downloads.find((x) => x.id === id); if (d) shell.showItemInFolder(d.path); });
ipcMain.handle("downloads:remove", (_e, id) => { downloads = downloads.filter((x) => x.id !== id); writeJSON(FILES.downloads, downloads); return downloads; });
ipcMain.handle("downloads:clear", () => { downloads = []; writeJSON(FILES.downloads, downloads); return downloads; });

ipcMain.handle("history:list", (_e, q) => {
  if (!q) return history.slice(0, 500);
  const s = String(q).toLowerCase();
  return history.filter((h) => (h.url + " " + (h.title || "")).toLowerCase().includes(s)).slice(0, 500);
});
ipcMain.handle("history:clear", () => { history = []; writeJSON(FILES.history, history); });
ipcMain.handle("history:remove", (_e, id) => { history = history.filter((h) => h.id !== id); writeJSON(FILES.history, history); return history; });

ipcMain.handle("bookmarks:list", () => bookmarks);
ipcMain.handle("bookmarks:add", (_e, b) => { const item = { id: crypto.randomUUID(), addedAt: Date.now(), ...b }; bookmarks.push(item); writeJSON(FILES.bookmarks, bookmarks); return item; });
ipcMain.handle("bookmarks:remove", (_e, id) => { bookmarks = bookmarks.filter((b) => b.id !== id); writeJSON(FILES.bookmarks, bookmarks); return bookmarks; });

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:update", (_e, patch) => { settings = { ...settings, ...patch }; writeJSON(FILES.settings, settings); return settings; });
ipcMain.handle("settings:pickDownloadDir", async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return settings;
  settings.downloadDir = r.filePaths[0]; writeJSON(FILES.settings, settings); return settings;
});

ipcMain.handle("extensions:list", () => {
  // Augment with icon data URL + popup url so the renderer can render the popover.
  return installedExtensions.map((e) => {
    let icon = "", popup = "";
    try {
      const manifestPath = path.join(e.path, "manifest.json");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const icons = m.icons || (m.action && m.action.default_icon) || (m.browser_action && m.browser_action.default_icon) || {};
      const iconRel = typeof icons === "string" ? icons : (icons["128"] || icons["64"] || icons["48"] || icons["32"] || icons["16"] || Object.values(icons)[0]);
      if (iconRel) {
        const iconPath = path.join(e.path, iconRel);
        if (fs.existsSync(iconPath)) {
          const buf = fs.readFileSync(iconPath);
          const ext = path.extname(iconPath).slice(1).toLowerCase() || "png";
          icon = `data:image/${ext};base64,${buf.toString("base64")}`;
        }
      }
      popup = (m.action && m.action.default_popup) || (m.browser_action && m.browser_action.default_popup) || "";
    } catch {}
    return { ...e, icon, popup };
  });
});
ipcMain.handle("extensions:loadFromFolder", async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return installedExtensions;
  const picked = r.filePaths[0];
  let imported = 0, skipped = 0;
  const errors = [];
  const tryInstall = async (folder) => {
    try { await installExtensionFromFolder(folder); imported++; }
    catch (e) { skipped++; errors.push(`${path.basename(folder)}: ${e?.message || e}`); }
  };
  if (fs.existsSync(path.join(picked, "manifest.json"))) {
    await tryInstall(picked);
  } else {
    const entries = await fsp.readdir(picked).catch(() => []);
    for (const sub of entries) {
      const subPath = path.join(picked, sub);
      let stat;
      try { stat = await fsp.stat(subPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let target = subPath;
      if (!fs.existsSync(path.join(subPath, "manifest.json"))) {
        const vers = (await fsp.readdir(subPath).catch(() => [])).filter((v) => !v.startsWith("."));
        if (!vers.length) { skipped++; continue; }
        vers.sort();
        target = path.join(subPath, vers[vers.length - 1]);
        if (!fs.existsSync(path.join(target, "manifest.json"))) { skipped++; continue; }
      }
      await tryInstall(target);
    }
  }
  dialog.showMessageBox(mainWindow, {
    type: imported > 0 ? "info" : "warning",
    title: "استيراد الإضافات",
    message: `تم استيراد ${imported} إضافة، وتخطي ${skipped}.`,
    detail: errors.slice(0, 10).join("\n") || undefined,
  });
  return installedExtensions;
});

ipcMain.handle("extensions:getPins", () => pinnedExtensionIds);
ipcMain.handle("extensions:togglePin", (_e, id) => {
  if (pinnedExtensionIds.includes(id)) {
    pinnedExtensionIds = pinnedExtensionIds.filter((x) => x !== id);
  } else {
    if (pinnedExtensionIds.length >= 10) return pinnedExtensionIds;
    pinnedExtensionIds = [...pinnedExtensionIds, id];
  }
  writeJSON(FILES.pinnedExtensions, pinnedExtensionIds);
  return pinnedExtensionIds;
});

ipcMain.handle("extensions:loadCrx", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"], filters: [{ name: "Chrome extension", extensions: ["crx", "zip"] }],
  });
  if (r.canceled || !r.filePaths[0]) return installedExtensions;
  const AdmZip = tryRequire("adm-zip");
  if (!AdmZip) {
    dialog.showMessageBox(mainWindow, { type: "warning", message: "مكتبة adm-zip غير مثبتة. شغّل: npm install داخل مجلد CUTE BROWSER ثم أعد البناء." });
    return installedExtensions;
  }
  const srcFile = r.filePaths[0];
  const tmpId = crypto.randomUUID();
  const dest = path.join(EXT_DIR, tmpId);
  fs.mkdirSync(dest, { recursive: true });
  try {
    // CRX files have a header before the embedded ZIP. Strip it.
    // CRX2: "Cr24" + u32 version + u32 pubKeyLen + u32 sigLen + key + sig + zip
    // CRX3: "Cr24" + u32 version(=3) + u32 headerLen + header + zip
    let buf = fs.readFileSync(srcFile);
    if (buf.slice(0, 4).toString("ascii") === "Cr24") {
      const version = buf.readUInt32LE(4);
      let zipStart;
      if (version === 2) {
        const pubKeyLen = buf.readUInt32LE(8);
        const sigLen = buf.readUInt32LE(12);
        zipStart = 16 + pubKeyLen + sigLen;
      } else {
        // CRX3
        const headerLen = buf.readUInt32LE(8);
        zipStart = 12 + headerLen;
      }
      buf = buf.slice(zipStart);
    }
    new AdmZip(buf).extractAllTo(dest, true);
    if (!fs.existsSync(path.join(dest, "manifest.json"))) {
      throw new Error("manifest.json غير موجود داخل الملف.");
    }
    await installExtensionFromFolder(dest);
    try { await fsp.rm(dest, { recursive: true, force: true }); } catch {}
    dialog.showMessageBox(mainWindow, { type: "info", title: "تم", message: "تم تثبيت الإضافة بنجاح." });
  } catch (e) {
    try { await fsp.rm(dest, { recursive: true, force: true }); } catch {}
    dialog.showMessageBox(mainWindow, { type: "error", title: "فشل التثبيت", message: "تعذّر فك ملف CRX/ZIP.", detail: String(e?.message || e) });
  }
  return installedExtensions;
});
ipcMain.handle("extensions:remove", async (_e, id) => {
  const ext = installedExtensions.find((x) => x.id === id);
  if (ext) {
    try { await session.defaultSession.removeExtension(id); } catch {}
    try { await fsp.rm(ext.path, { recursive: true, force: true }); } catch {}
  }
  installedExtensions = installedExtensions.filter((x) => x.id !== id);
  writeJSON(FILES.extensions, installedExtensions);
  return installedExtensions;
});

ipcMain.handle("files:openLocal", async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] });
  if (r.canceled || !r.filePaths[0]) return null;
  const id = createTab("file://" + r.filePaths[0]);
  return id;
});
ipcMain.handle("files:readText", async (_e, p) => fsp.readFile(p, "utf8"));

// ---- Extension popup floating window ------------------------------------
/** @type {BrowserWindow|null} */
let extPopupWin = null;
function closeExtPopup() {
  if (extPopupWin && !extPopupWin.isDestroyed()) {
    try { extPopupWin.close(); } catch {}
  }
  extPopupWin = null;
}
ipcMain.handle("extensions:openPopup", async (_e, id, anchor) => {
  const ext = installedExtensions.find((x) => x.id === id);
  if (!ext) return;
  const active = tabs.get(activeTabId);
  if (active && chromeExtensions?.api?.browserAction) {
    try {
      chromeExtensions.api.browserAction.activate(
        { type: "frame", sender: mainWindow.webContents },
        {
          eventType: "click",
          extensionId: id,
          tabId: active.view.webContents.id,
          alignment: "bottom right",
          anchorRect: {
            x: anchor?.x ?? Math.max(0, (anchor?.right ?? 0) - 32),
            y: anchor?.y ?? Math.max(0, (anchor?.bottom ?? CHROME_HEIGHT) - 32),
            width: anchor?.width ?? 32,
            height: anchor?.height ?? 32,
          },
        },
      );
      return;
    } catch (err) {
      console.warn("native extension action failed, falling back", err?.message);
    }
  }
  let popup = "";
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ext.path, "manifest.json"), "utf8"));
    popup = (m.action && m.action.default_popup) || (m.browser_action && m.browser_action.default_popup) || "";
  } catch {}
  if (!popup) {
    // No popup defined — invoke the action programmatically (background-only extensions)
    try {
      const exts = session.defaultSession.extensions;
      if (exts && exts.getExtension(id)) {
        if (active) await active.view.webContents.executeJavaScript("(()=>{})()").catch(()=>{});
      }
    } catch {}
    return;
  }
  closeExtPopup();
  const winBounds = mainWindow.getContentBounds();
  const w = 380, h = 560;
  const ax = anchor?.right ?? (winBounds.width - 40);
  const ay = anchor?.bottom ?? CHROME_HEIGHT;
  const screenX = winBounds.x + Math.max(8, Math.min(winBounds.width - w - 8, ax - w));
  const screenY = winBounds.y + Math.min(winBounds.height - h - 8, ay + 6);
  extPopupWin = new BrowserWindow({
    parent: mainWindow, modal: false, frame: false, transparent: true,
    width: w, height: h, x: Math.round(screenX), y: Math.round(screenY),
    resizable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    backgroundColor: "#00000000", hasShadow: true, show: false,
    webPreferences: { session: session.defaultSession, contextIsolation: true },
  });
  extPopupWin.on("blur", () => closeExtPopup());
  extPopupWin.on("closed", () => { extPopupWin = null; });
  await extPopupWin.loadURL(`chrome-extension://${id}/${popup}`);
  extPopupWin.show();
});
ipcMain.handle("extensions:closePopup", () => closeExtPopup());

// Capture the active tab as a PNG dataURL so the renderer can show it as a
// frozen backdrop while floating popovers are open (tab view is detached for
// HTML popovers to be visible, but the user still sees their page underneath).
ipcMain.handle("tabs:capture", async () => {
  const t = tabs.get(activeTabId);
  if (!t) return null;
  try {
    const img = await t.view.webContents.capturePage();
    return img.toDataURL();
  } catch { return null; }
});
ipcMain.handle("tabs:saveCapture", () => saveActiveCapture());

ipcMain.handle("importer:chrome", async () => {
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [path.join(home, "AppData/Local/Google/Chrome/User Data/Default")]
    : process.platform === "darwin"
    ? [path.join(home, "Library/Application Support/Google/Chrome/Default")]
    : [path.join(home, ".config/google-chrome/Default"), path.join(home, ".config/chromium/Default")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return { ok: false, message: "لم يتم العثور على بروفايل Chrome" };
  // Bookmarks
  try {
    const bm = JSON.parse(fs.readFileSync(path.join(found, "Bookmarks"), "utf8"));
    const walk = (node) => {
      if (!node) return;
      if (node.type === "url") bookmarks.push({ id: crypto.randomUUID(), title: node.name, url: node.url, addedAt: Date.now() });
      (node.children || []).forEach(walk);
    };
    Object.values(bm.roots || {}).forEach(walk);
    writeJSON(FILES.bookmarks, bookmarks);
  } catch {}
  return { ok: true, message: "تم استيراد البوكمارك من Chrome" };
});

function tryRequire(name) { try { return require(name); } catch { return null; } }

// ---- App lifecycle --------------------------------------------------------
app.whenReady().then(() => {
  wireDownloads(session.defaultSession);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
