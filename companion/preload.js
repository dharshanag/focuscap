// Bridges the sandboxed overlay renderer to the main process's lock state
// without handing it raw Node/fs access (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("focusCap", {
  getState: () => ipcRenderer.invoke("get-state"),
  // The pill window is reused across locks: main asks for a refresh before
  // showing it, and waits for rendered() so stale text never flashes.
  onRefresh: (cb) => ipcRenderer.on("focuscap:refresh", () => cb()),
  rendered: () => ipcRenderer.send("focuscap:rendered")
});
