const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "trafficControlSetup",
  Object.freeze({
    onStatus(callback) {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("setup-status", listener);
      return () => ipcRenderer.removeListener("setup-status", listener);
    },
    retry: () => ipcRenderer.invoke("setup-retry"),
  }),
);
