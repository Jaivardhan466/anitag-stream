/**
 * Native Windows Desktop Runtime for AniTAG (CloudStream Engine + almost anitag UI)
 * Runs native on Windows 10/11 with WebView2 / Chromium hardware-accelerated video decoding.
 * Strict zero-popup & zero-redirect enforcement via Electron WebContents handlers.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let engineProcess = null;
const SERVER_PORT = 4000;

function startLocalStreamingEngine() {
  const serverPath = path.resolve(__dirname, "../engine/server.js");
  engineProcess = fork(serverPath, [], {
    env: { ...process.env, PORT: SERVER_PORT.toString() },
    stdio: "inherit"
  });

  engineProcess.on("error", (err) => {
    console.error("[Desktop Windows] Streaming engine process error:", err);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: "AniTAG — Stream Engine",
    icon: path.resolve(__dirname, "../client/icon-512.png"),
    backgroundColor: "#0b0b0e",
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  // Strict Zero-Popup & Zero-Redirect Security on Windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn("[Windows Shield] Blocked popup window request to:", url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      event.preventDefault();
      console.warn("[Windows Shield] Blocked external navigation to:", url);
    }
  });

  // Load the native almost anitag UI
  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}/`);
  }, 800);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Register Windows Keyboard Media Controls (Play, Pause, Next, Prev)
  globalShortcut.register("MediaPlayPause", () => {
    mainWindow.webContents.send("MEDIA_KEY_COMMAND", "TOGGLE_PLAY");
  });
  globalShortcut.register("MediaNextTrack", () => {
    mainWindow.webContents.send("MEDIA_KEY_COMMAND", "NEXT_EPISODE");
  });
  globalShortcut.register("MediaPreviousTrack", () => {
    mainWindow.webContents.send("MEDIA_KEY_COMMAND", "PREV_EPISODE");
  });
}

app.whenReady().then(() => {
  startLocalStreamingEngine();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (engineProcess) {
    engineProcess.kill();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
