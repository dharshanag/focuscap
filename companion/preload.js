// Bridges the sandboxed overlay renderer to the main process's lock state
// without handing it raw Node/fs access (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("focusCap", {
  getState: () => ipcRenderer.invoke("get-state")
});
