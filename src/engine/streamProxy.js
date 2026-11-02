/**
 * Universal HLS/MP4 Stream Proxy & Playlist Rewriter
 * Proxies streams with custom User-Agent and Referer headers to bypass anti-hotlinking.
 * Rewrites .m3u8 playlists so video players never encounter CORS issues or broken segment links.
 */

import { Readable } from "node:stream";
import { isAdOrTrackerUrl } from "./adblocker.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function proxyAssetUrl(value, baseUrl, referer) {
  const target = new URL(value, baseUrl).toString();
  const params = new URLSearchParams({
    url: target,
    referer: referer || new URL(target).origin
  });
  return `/proxy?${params.toString()}`;
}

export async function serveStreamProxy(req, res, parsedUrl) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range"
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  const rawTarget = parsedUrl.searchParams.get("url") || "";
  if (!rawTarget) {
    res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
    return res.end(JSON.stringify({ error: "Missing stream url parameter" }));
  }

  // Ad block check
  if (isAdOrTrackerUrl(rawTarget)) {
    res.writeHead(403, { "Content-Type": "application/json", ...corsHeaders });
    return res.end(JSON.stringify({ error: "Ad URL blocked by AniTAG Shield" }));
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
    return res.end(JSON.stringify({ error: "Invalid stream URL" }));
  }

  let refererOrigin = target.origin;
  const rawRef = parsedUrl.searchParams.get("referer");
  if (rawRef) {
    try {
      refererOrigin = new URL(rawRef).origin;
    } catch {}
  }

  try {
    const requestHeaders = {
      "User-Agent": UA,
      "Referer": refererOrigin + "/",
      "Origin": refererOrigin,
      "Accept": "*/*"
    };

    if (req.headers.range) {
      requestHeaders["Range"] = req.headers.range;
    }

    let upstream = null;
    let current = target;

    // Follow up to 5 redirects while blocking ad redirect traps
    for (let attempt = 0; attempt < 5; attempt++) {
      if (isAdOrTrackerUrl(current.href)) {
        throw new Error("Redirected to blocked ad domain: " + current.hostname);
      }
      upstream = await fetch(current.href, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: requestHeaders,
        redirect: "manual"
      });

      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location) break;
      current = new URL(location, current);
    }

    if (!upstream) throw new Error("No response from upstream stream source");

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const isNamedPlaylist = /\.m3u8(?:$|\?)/i.test(current.href) || contentType.toLowerCase().includes("mpegurl");
    const isBinaryMedia = /\.(?:ts|m4s|mp4|webm|aac|mp3|vtt)(?:$|\?)/i.test(current.href);
    const contentLen = Number(upstream.headers.get("content-length") || 0);

    const responseHeaders = {
      ...corsHeaders,
      "Content-Type": isNamedPlaylist ? "application/vnd.apple.mpegurl" : contentType,
      "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes"
    };

    if (upstream.headers.get("content-length") && !isNamedPlaylist) {
      responseHeaders["Content-Length"] = upstream.headers.get("content-length");
    }
    if (upstream.headers.get("content-range")) {
      responseHeaders["Content-Range"] = upstream.headers.get("content-range");
    }

    if (req.method === "HEAD" || !upstream.body) {
      res.writeHead(upstream.status, responseHeaders);
      return res.end();
    }

    // Process HLS .m3u8 playlist: rewrite segments and key URIs to local proxy
    if (upstream.ok && (isNamedPlaylist || (!isBinaryMedia && contentLen < 524288))) {
      const rawBuf = Buffer.from(await upstream.arrayBuffer());
      const headStr = rawBuf.subarray(0, 16).toString("utf8").trimStart();

      if (isNamedPlaylist || headStr.startsWith("#EXTM3U")) {
        const playlist = rawBuf.toString("utf8");
        const rewrite = (uri) => proxyAssetUrl(uri, current.href, refererOrigin);

        const rewritten = playlist
          .replace(/(URI=")([^"]+)(")/g, (_match, before, uri, after) => `${before}${rewrite(uri)}${after}`)
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith("#") ? rewrite(trimmed) : line;
          })
          .join("\n");

        delete responseHeaders["Content-Length"];
        responseHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
        res.writeHead(200, responseHeaders);
        return res.end(rewritten);
      }

      res.writeHead(upstream.status, responseHeaders);
      return res.end(rawBuf);
    }

    // Binary streaming (video chunks, .ts, .mp4, audio)
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body && typeof upstream.body.getReader === "function") {
      const streamBody = Readable.fromWeb(upstream.body);
      res.on("close", () => streamBody.destroy());
      streamBody.on("error", () => {
        if (!res.headersSent) res.writeHead(502, corsHeaders);
        res.end();
      });
      return streamBody.pipe(res);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json", ...corsHeaders });
      return res.end(JSON.stringify({ error: "Stream proxy error: " + err.message }));
    }
    res.end();
  }
}
