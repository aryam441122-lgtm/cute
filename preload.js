// preload.js — bridges the renderer (chrome UI + loaded pages) to main via a
// safe `window.cuteBrowser` API. Context isolation stays ON.
const { contextBridge, ipcRenderer } = require("electron");

try { require("electron-chrome-extensions/browser-action").injectBrowserAction(); } catch {}

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const api = {
  // Tabs
  tabs: {
    list: () => invoke("tabs:list"),
    create: (url) => invoke("tabs:create", url),
    close: (id) => invoke("tabs:close", id),
    closeOthers: (id) => invoke("tabs:closeOthers", id),
    duplicate: (id) => invoke("tabs:duplicate", id),
    muteToggle: (id) => invoke("tabs:muteToggle", id),
    copyUrl: (id) => invoke("tabs:copyUrl", id),
    activate: (id) => invoke("tabs:activate", id),
    reorder: (ids) => invoke("tabs:reorder", ids),
    navigate: (id, url) => invoke("tabs:navigate", id, url),
    capture: () => invoke("tabs:capture"),
    back: (id) => invoke("tabs:back", id),
    forward: (id) => invoke("tabs:forward", id),
    reload: (id) => invoke("tabs:reload", id),
    saveCapture: () => invoke("tabs:saveCapture"),
    onUpdate: (cb) => {
      const fn = (_e, payload) => cb(payload);
      ipcRenderer.on("tabs:update", fn);
      return () => ipcRenderer.removeListener("tabs:update", fn);
    },
  },
  // Downloads
  downloads: {
    list: () => invoke("downloads:list"),
    open: (id) => invoke("downloads:open", id),
    reveal: (id) => invoke("downloads:reveal", id),
    remove: (id) => invoke("downloads:remove", id),
    clear: () => invoke("downloads:clear"),
    onUpdate: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on("downloads:update", fn);
      return () => ipcRenderer.removeListener("downloads:update", fn);
    },
  },
  // History
  history: {
    list: (q) => invoke("history:list", q),
    clear: () => invoke("history:clear"),
    remove: (id) => invoke("history:remove", id),
  },
  // Bookmarks
  bookmarks: {
    list: () => invoke("bookmarks:list"),
    add: (b) => invoke("bookmarks:add", b),
    remove: (id) => invoke("bookmarks:remove", id),
  },
  // Settings
  settings: {
    get: () => invoke("settings:get"),
    update: (patch) => invoke("settings:update", patch),
    pickDownloadDir: () => invoke("settings:pickDownloadDir"),
  },
  // Extensions
  extensions: {
    list: () => invoke("extensions:list"),
    getPins: () => invoke("extensions:getPins"),
    togglePin: (id) => invoke("extensions:togglePin", id),
    loadFromFolder: () => invoke("extensions:loadFromFolder"),
    loadCrx: () => invoke("extensions:loadCrx"),
    remove: (id) => invoke("extensions:remove", id),
    openPopup: (id, anchor) => invoke("extensions:openPopup", id, anchor),
    closePopup: () => invoke("extensions:closePopup"),
  },
  // File / media viewer
  files: {
    openLocal: () => invoke("files:openLocal"),
    readText: (path) => invoke("files:readText", path),
  },
  // Import from Chrome
  importer: {
    chrome: () => invoke("importer:chrome"),
  },
  // Shell / window
  shell: {
    ready: (payload) => invoke("shell:ready", payload),
    setChromeHeight: (h) => invoke("shell:setChromeHeight", h),
    setTabsVisible: (v) => invoke("shell:setTabsVisible", v),
  },
  window: {
    minimize: () => invoke("window:minimize"),
    maximizeToggle: () => invoke("window:maximizeToggle"),
    close: () => invoke("window:close"),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("cuteBrowser", api);
