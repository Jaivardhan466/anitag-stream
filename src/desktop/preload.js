/**
 * Secure Preload Bridge for Windows Desktop
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  platform: "windows",
  onMediaKey: (callback) => {
    ipcRenderer.on("MEDIA_KEY_COMMAND", (_event, command) => callback(command));
  }
});
