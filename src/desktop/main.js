/**
 * Native Windows Desktop Runtime for AniTAG (CloudStream Engine + almost anitag UI)
 * Runs native on Windows 10/11 with WebView2 / Chromium hardware-accelerated video decoding.
 * Strict zero-popup & zero-redirect enforcement via Electron WebContents handlers.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let engineProcess = null;
const SERVER_PORT = 4000;

function pollServerUntilReady(port, onReady, maxRetries = 60, intervalMs = 250) {
  let attempts = 0;
  let finished = false;

  const trigger = () => {
    if (!finished) {
      finished = true;
      onReady();
    }
  };

  const check = () => {
    if (finished) return;
    attempts++;
    const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        trigger();
      } else if (attempts < maxRetries) {
        setTimeout(check, intervalMs);
      } else {
        trigger();
      }
    });

    req.on("error", () => {
      if (attempts < maxRetries) {
        setTimeout(check, intervalMs);
      } else {
        trigger();
      }
    });

    req.setTimeout(500, () => {
      req.destroy();
      if (attempts < maxRetries) {
        setTimeout(check, intervalMs);
      } else {
        trigger();
      }
    });
  };

  check();
}

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

  // Strict Zero-Popup & Zero-Redirect Security on Windows with OAuth external delegation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (
        parsed.hostname === "accounts.google.com" ||
        parsed.hostname.endsWith(".supabase.co") ||
        parsed.hostname.includes("google") ||
        parsed.hostname === "github.com"
      ) {
        shell.openExternal(url);
      } else {
        console.warn("[Windows Shield] Blocked untrusted popup window request to:", url);
      }
    } catch (e) {
      console.warn("[Windows Shield] Malformed window open URL:", url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        return; // Allow local streaming UI navigation
      }

      event.preventDefault();
      if (
        parsed.hostname === "accounts.google.com" ||
        parsed.hostname.endsWith(".supabase.co") ||
        parsed.hostname.includes("google") ||
        parsed.hostname === "github.com"
      ) {
        console.log("[Windows Shield] Delegating OAuth navigation to system browser:", url);
        shell.openExternal(url);
      } else {
        console.warn("[Windows Shield] Blocked external navigation to:", url);
      }
    } catch (e) {
      event.preventDefault();
      console.warn("[Windows Shield] Invalid navigation URL:", url);
    }
  });

  // Resiliently poll streaming engine health before loading the UI
  pollServerUntilReady(SERVER_PORT, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://localhost:${SERVER_PORT}/`);
    }
  });

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
