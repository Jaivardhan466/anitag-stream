/**
 * AniTAG Network-Level Ad & Tracker Filter
 * Used strictly by the Stream Proxy to avoid fetching from known ad/tracking networks.
 * Note: Brittle DOM-level monkey-patching and zIndex mutation observers have been removed
 * to ensure video player controls, subtitles, and provider iframes are not disrupted.
 */

export const BLOCKED_HOST_PATTERNS = [
  /popads/i,
  /adsterra/i,
  /propellerads/i,
  /monetag/i,
  /adnxs/i,
  /doubleclick/i,
  /googleadservices/i,
  /histats/i,
  /onclick/i,
  /syndication/i,
  /exoclick/i,
  /juicyads/i,
  /trafficjunky/i,
  /yllix/i,
  /zeroredirect/i,
  /adservice/i,
  /coin-hive/i,
  /adsupply/i,
  /admaven/i,
  /bet365/i,
  /1xbet/i,
  /clickadu/i,
  /hilltopads/i,
  /richpush/i,
  /popcash/i
];

/**
 * Returns true if a URL should be strictly blocked by the ad filter
 */
export function isAdOrTrackerUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    for (const pattern of BLOCKED_HOST_PATTERNS) {
      if (pattern.test(host) || pattern.test(pathname)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
