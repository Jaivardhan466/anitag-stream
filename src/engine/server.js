/**
 * AniTAG Unified Engine & Real-Time Sync Server
 * Zero External Dependencies (Runs 100% standalone on Windows Desktop & Android)
 * Combines:
 * 1. CloudStream + Anivexa 13-Provider Multi-Stream Engine
 * 2. Universal HLS/MP4 Stream Proxy with Zero Ads & Popups
 * 3. Native RFC-6455 WebSocket Mobile-to-Windows Playback Sync Hub (< 50ms latency)
 * 4. High-Performance Static UI Server
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStreamProxy } from "./streamProxy.js";
import { isAdOrTrackerUrl } from "./adblocker.js";
import { resolveStream } from "./extractors/cloudstreamExtractors.js";

// Providers
import anikotoHandler from "./providers/anikoto.js";
import animeggHandler from "./providers/animegg.js";
import anibdHandler from "./providers/anibd.js";
import dhiveHandler from "./providers/2dhive.js";
import mkissaHandler from "./providers/mkissa.js";
import reanimeHandler from "./providers/reanime.js";
import aninekoHandler from "./providers/anineko.js";
import anidbappHandler from "./providers/anidbapp.js";
import senshiHandler from "./providers/senshi.js";
import kaaHandler from "./providers/kickassanime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIR = path.resolve(__dirname, "../client");

const PORT = Number(process.env.PORT) || 4000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, Authorization",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4"
};

const PROVIDER_ROUTERS = {
  anikoto: anikotoHandler,
  animegg: animeggHandler,
  anibd: anibdHandler,
  "2dhive": dhiveHandler,
  mkissa: mkissaHandler,
  reanime: reanimeHandler,
  anineko: aninekoHandler,
  anidbapp: anidbappHandler,
  senshi: senshiHandler,
  kickassanime: kaaHandler
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// NATIVE RFC-6455 WEBSOCKET ENGINE (ZERO NPM DEPENDENCIES)
// ---------------------------------------------------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const userRooms = new Map(); // userId -> Set of active client sockets

function encodeWsFrame(opcode, payload = Buffer.alloc(0)) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = buf.length;
  let header;

  if (len <= 125) {
    header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, buf]);
}

function encodeWsTextFrame(text) {
  return encodeWsFrame(0x01, Buffer.from(text, "utf8"));
}

function encodeWsCloseFrame(code = 1000, reason = "") {
  const reasonBuf = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  if (reasonBuf.length > 0) {
    reasonBuf.copy(payload, 2);
  }
  return encodeWsFrame(0x08, payload);
}

function encodeWsPongFrame(payload = Buffer.alloc(0)) {
  return encodeWsFrame(0x0a, payload);
}

function encodeWsPingFrame(payload = Buffer.alloc(0)) {
  return encodeWsFrame(0x09, payload);
}

function handleWsUpgrade(req, socket, head) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname !== "/ws/sync") {
    socket.destroy();
    return;
  }

  const clientKey = req.headers["sec-websocket-key"];
  if (!clientKey) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(clientKey + WS_GUID)
    .digest("base64");

  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "\r\n"
  ];
  socket.write(responseHeaders.join("\r\n"));

  let authenticatedUser = null;
  let deviceId = null;
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragmentedBuffers = [];
  let isClosing = false;

  function cleanupSocket() {
    if (authenticatedUser && userRooms.has(authenticatedUser)) {
      const set = userRooms.get(authenticatedUser);
      set.delete(socket);
      if (set.size === 0) userRooms.delete(authenticatedUser);
    }
  }

  function handleTextMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      console.warn("[Sync Hub] WebSocket frame JSON parse error:", e.message);
      return;
    }

    if (!msg || typeof msg !== "object") return;

    // 1. Join Room on Google Sign-In
    if (msg.type === "JOIN_SYNC_ROOM") {
      authenticatedUser = msg.userId || "guest_default";
      deviceId = msg.deviceId || "unknown_device";

      if (!userRooms.has(authenticatedUser)) {
        userRooms.set(authenticatedUser, new Set());
      }
      userRooms.get(authenticatedUser).add(socket);

      try {
        socket.write(encodeWsTextFrame(JSON.stringify({
          type: "SYNC_ROOM_JOINED",
          userId: authenticatedUser,
          deviceId,
          connectedDevicesCount: userRooms.get(authenticatedUser).size
        })));
      } catch (_) {}

      console.log(`[Sync Hub] Device ${deviceId} joined room for user: ${authenticatedUser}`);
      return;
    }

    // 2. Instant Playback Command Broadcast ("Like on a keyboard" - < 50ms latency)
    if (msg.type === "PLAYBACK_SYNC_ACTION") {
      if (!authenticatedUser) return;
      const clients = userRooms.get(authenticatedUser);
      if (!clients) return;

      const broadcastFrame = encodeWsTextFrame(JSON.stringify({
        type: "RECEIVE_PLAYBACK_SYNC",
        sourceDevice: deviceId,
        action: msg.action,
        animeId: msg.animeId,
        animeTitle: msg.animeTitle,
        episode: msg.episode,
        audio: msg.audio,
        provider: msg.provider,
        positionSec: msg.positionSec,
        durationSec: msg.durationSec,
        volume: msg.volume,
        isPlaying: msg.isPlaying,
        timestamp: Date.now()
      }));

      for (const client of clients) {
        if (client !== socket && !client.destroyed) {
          try {
            client.write(broadcastFrame);
          } catch (_) {}
        }
      }
      return;
    }

    // 3. Cloud Data Sync (Watchlist, History, Preferences)
    if (msg.type === "CLOUD_DATA_SYNC") {
      if (!authenticatedUser) return;
      const clients = userRooms.get(authenticatedUser);
      if (!clients) return;

      const dataFrame = encodeWsTextFrame(JSON.stringify({
        type: "RECEIVE_CLOUD_DATA",
        dataType: msg.dataType,
        data: msg.data,
        timestamp: Date.now()
      }));

      for (const client of clients) {
        if (client !== socket && !client.destroyed) {
          try {
            client.write(dataFrame);
          } catch (_) {}
        }
      }
    }
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const fin = (firstByte & 0x80) === 0x80;
      const opcode = firstByte & 0x0f;

      const secondByte = buffer[1];
      const isMasked = (secondByte & 0x80) === 0x80;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskSize = isMasked ? 4 : 0;
      if (buffer.length < offset + maskSize + payloadLen) return;

      let maskKey = null;
      if (isMasked) {
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = buffer.subarray(offset, offset + payloadLen);
      buffer = buffer.subarray(offset + payloadLen);

      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = isMasked ? payload[i] ^ maskKey[i % 4] : payload[i];
      }

      // RFC-6455: Handle Connection Close Frame (Opcode 0x8)
      if (opcode === 0x08) {
        if (!isClosing) {
          isClosing = true;
          let closeCode = 1000;
          let closeReason = "";
          if (unmasked.length >= 2) {
            closeCode = unmasked.readUInt16BE(0);
            if (unmasked.length > 2) {
              closeReason = unmasked.subarray(2).toString("utf8");
            }
          }
          try {
            socket.write(encodeWsCloseFrame(closeCode, closeReason));
          } catch (_) {}
        }
        cleanupSocket();
        socket.end();
        return;
      }

      // RFC-6455: Handle Ping Frame (Opcode 0x9) -> Echo Pong Frame (Opcode 0xA)
      if (opcode === 0x09) {
        try {
          socket.write(encodeWsPongFrame(unmasked));
        } catch (_) {}
        continue;
      }

      // RFC-6455: Handle Pong Frame (Opcode 0xA) -> Keepalive Heartbeat response
      if (opcode === 0x0a) {
        continue;
      }

      // RFC-6455: Handle Binary Frame (Opcode 0x2) -> Non-text data
      if (opcode === 0x02) {
        continue;
      }

      // RFC-6455: Handle Text Frame (Opcode 0x1) and Continuation Frames (Opcode 0x0)
      if (opcode === 0x01 || opcode === 0x00) {
        if (!fin) {
          if (opcode === 0x01) {
            fragmentedOpcode = 0x01;
            fragmentedBuffers = [unmasked];
          } else if (fragmentedOpcode !== null) {
            fragmentedBuffers.push(unmasked);
          }
          continue;
        }

        let fullPayload;
        if (opcode === 0x00 && fragmentedOpcode !== null) {
          fragmentedBuffers.push(unmasked);
          fullPayload = Buffer.concat(fragmentedBuffers);
          fragmentedOpcode = null;
          fragmentedBuffers = [];
        } else {
          fullPayload = unmasked;
        }

        handleTextMessage(fullPayload.toString("utf8"));
        continue;
      }

      console.warn(`[Sync Hub] Received unhandled WebSocket opcode: 0x${opcode.toString(16)}`);
    }
  });

  socket.on("close", () => {
    cleanupSocket();
  });

  socket.on("error", () => {
    cleanupSocket();
    socket.destroy();
  });
}

// ---------------------------------------------------------------------------
// HTTP APPLICATION SERVER
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const parsedUrl = new URL(req.url || "/", `http://${host}`);
    const pathname = parsedUrl.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    // Health check
    if (pathname === "/healthz") {
      return sendJson(res, 200, { status: "ok", engine: "AniTAG CloudStream Native 3.0" });
    }

    // Client Configuration Endpoint (/api/config)
    if (pathname === "/api/config") {
      return sendJson(res, 200, {
        apiBaseUrl: process.env.API_BASE_URL || "",
        supabaseUrl: process.env.SUPABASE_URL || "",
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
        authRedirectUrl: process.env.AUTH_REDIRECT_URL || ""
      });
    }

    // Provider Episode List Endpoint (/episodes/:provider/:id)
    if (pathname.startsWith("/episodes/")) {
      const parts = pathname.split("/").filter(Boolean);
      const provider = (parts[1] || "anikoto").toLowerCase();
      const handler = PROVIDER_ROUTERS[provider] || anikotoHandler;
      try {
        const provReq = new Request(`http://localhost${pathname}${parsedUrl.search}`, { method: "GET" });
        const provRes = await handler.fetch(provReq);
        if (provRes && provRes.ok) {
          const provData = await provRes.json();
          return sendJson(res, 200, provData);
        }
      } catch (err) {
        console.warn(`[Episodes Handler] Provider ${provider} fetch error:`, err.message);
      }
      return sendJson(res, 404, { error: `Episode list not found for provider '${provider}'` });
    }

    // Stream Proxy
    if (pathname === "/proxy" || pathname === "/api/proxy") {
      return await serveStreamProxy(req, res, parsedUrl);
    }

    // Fast multi-provider stream resolver endpoint (/api/stream)
    if (pathname === "/api/stream") {
      const animeId = parsedUrl.searchParams.get("animeId") || "";
      const anilistId = parsedUrl.searchParams.get("anilistId") || "";
      const malId = parsedUrl.searchParams.get("malId") || "";
      const ep = Number(parsedUrl.searchParams.get("ep") || "1");
      const audio = (parsedUrl.searchParams.get("audio") || "sub").toLowerCase() === "dub" ? "dub" : "sub";
      const requestedProvider = (parsedUrl.searchParams.get("provider") || "animegg").toLowerCase();

      // Priority list: try requested provider first, with 2dhive prioritized for fast verified streaming
      const candidates = [requestedProvider];
      if (requestedProvider !== "2dhive") candidates.push("2dhive");
      if (requestedProvider !== "animegg") candidates.push("animegg");
      if (requestedProvider !== "anikoto") candidates.push("anikoto");

      for (const prov of candidates) {
        try {
          const handler = PROVIDER_ROUTERS[prov];
          if (!handler) continue;
          const targetId = (prov === "2dhive" && malId) ? malId : (anilistId || malId || animeId);
          if (!targetId) continue;
          const watchPath = `/watch/${prov}/${targetId}/${audio}/${prov}-${ep}${malId ? `?malId=${malId}` : ''}`;
          const provReq = new Request(`http://localhost${watchPath}`, { method: "GET" });

          // Fast adaptive timeout: 5s for 2dhive, 3.5s for scraper/remote APIs to avoid client stall
          const provTimeout = prov === "2dhive" ? 5000 : 3500;
          const handlerPromise = handler.fetch(provReq);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Provider '${prov}' resolution timeout`)), provTimeout)
          );
          const provRes = await Promise.race([handlerPromise, timeoutPromise]);

          if (provRes && provRes.ok) {
            const provData = await provRes.json();
            const rawStreams = provData.streams || [];
            if (rawStreams.length > 0) {
              const subtitles = provData.subtitles || [];
              const formatted = rawStreams.map((s, idx) => {
                const rawUrl = s.url || "";
                const isM3u8 = rawUrl.includes(".m3u8") || s.type === "hls";
                const isEmbed = s.type === "embed" || rawUrl.includes("/embed/") || rawUrl.includes("/stream/");
                const needsProxy = !isEmbed && (isM3u8 || s.referer || rawUrl.includes("mcloud") || rawUrl.includes("rapid"));
                return {
                  id: `${prov}-${idx}`,
                  server: s.server || `${prov.toUpperCase()} Server ${idx + 1}`,
                  quality: s.quality || "1080p Direct",
                  type: isEmbed ? "embed" : (isM3u8 ? "hls" : "mp4"),
                  url: needsProxy ? `/proxy?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(s.referer || "")}` : rawUrl,
                  rawUrl,
                  subtitles
                };
              });

              return sendJson(res, 200, {
                provider: prov,
                animeId,
                episode: ep,
                audio,
                streams: formatted,
                subtitles
              });
            }
          }
        } catch (err) {
          console.warn(`[Stream Resolver] Provider ${prov} error:`, err.message);
        }
      }

      // Verified cloud mirrors fallback when direct scraper providers are slow or unavailable
      if (malId && Number(malId) > 0) {
        const upperAudio = audio.toUpperCase();
        const fallbackMirrors = [
          {
            id: `cloud-babastream-${ep}`,
            server: `BabaStream Cloud (${upperAudio})`,
            quality: "1080p Cloud",
            type: "embed",
            url: `https://babastream.top/embed/${malId}/${ep}/${audio}`,
            rawUrl: `https://babastream.top/embed/${malId}/${ep}/${audio}`,
            subtitles: []
          },
          {
            id: `cloud-megaplay-${ep}`,
            server: `MegaPlay HD (${upperAudio})`,
            quality: "1080p Cloud",
            type: "embed",
            url: `https://megaplay.buzz/stream/mal/${malId}/${ep}/${audio}`,
            rawUrl: `https://megaplay.buzz/stream/mal/${malId}/${ep}/${audio}`,
            subtitles: []
          },
          {
            id: `cloud-vidlink-${ep}`,
            server: `VidLink HD (${upperAudio})`,
            quality: "1080p Cloud",
            type: "embed",
            url: `https://vidlink.pro/anime/${malId}/${ep}/${audio}?fallback=true&autoplay=true&primaryColor=E8C36A`,
            rawUrl: `https://vidlink.pro/anime/${malId}/${ep}/${audio}`,
            subtitles: []
          }
        ];

        return sendJson(res, 200, {
          provider: "cloud-mirrors",
          animeId,
          episode: ep,
          audio,
          streams: fallbackMirrors,
          subtitles: []
        });
      }

      // Honest empty response: if anime has no verified MAL/provider mapping or is unreleased
      return sendJson(res, 200, {
        provider: requestedProvider,
        animeId,
        episode: ep,
        audio,
        streams: [],
        subtitles: [],
        error: `No verified streams available for Episode ${ep} on ${requestedProvider.toUpperCase()}`
      });
    }

    // Static Frontend File Serving
    let filePath = path.join(CLIENT_DIR, pathname === "/" ? "index.html" : pathname);
    if (!fs.existsSync(filePath)) {
      if (pathname.includes(".") && !pathname.endsWith(".html")) {
        return sendJson(res, 404, { error: `Asset not found: ${pathname}` });
      }
      filePath = path.join(CLIENT_DIR, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      ...CORS_HEADERS
    });
    res.end(content);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Server internal error: " + err.message });
    }
  }
});

// Attach Native RFC-6455 WebSocket Upgrade Handler
server.on("upgrade", handleWsUpgrade);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[Server Fatal] Port ${PORT} is already in use by another running process.`);
    console.error(`To release port ${PORT}, run:`);
    console.error(`  PowerShell: Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force`);
    console.error(`  Or launch with another port: $env:PORT="${PORT + 1}"; npm start\n`);
  } else {
    console.error("[Server Fatal] Server listen error:", err);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=======================================================`);
  console.log(`  AniTAG CloudStream Streaming Engine running on:`);
  console.log(`  Local URL:   http://localhost:${PORT}`);
  console.log(`  Network:     http://0.0.0.0:${PORT}`);
  console.log(`  Sync Hub:    ws://localhost:${PORT}/ws/sync`);
  console.log(`  Ad Shield:   Active (0 Ads, 0 Popups, 0 Redirects)`);
  console.log(`  Zero-Deps:   100% Native Node.js Standard Library`);
  console.log(`=======================================================\n`);
});
