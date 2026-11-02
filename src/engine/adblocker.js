/**
 * Zero-Ad, Zero-Popup & Zero-Redirect Filter Engine
 * Enforces strict network-level and DOM-level ad/popup/redirect blocking.
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

/**
 * Browser-side anti-ad & anti-popup script injected into WebView / Document
 */
export const CLIENT_ADBLOCK_SCRIPT = `
(function() {
  'use strict';
  // 1. Strict Window.Open Defeat
  window.open = function() {
    console.warn('[AniTAG Shield] Blocked popup window.open attempt');
    return null;
  };

  // 2. Strict Navigation & Redirect Prevention
  const originalAssign = window.location.assign.bind(window.location);
  const originalReplace = window.location.replace.bind(window.location);

  function isSafeNavigation(target) {
    try {
      const currentHost = window.location.hostname;
      const targetHost = new URL(target, window.location.href).hostname;
      return targetHost === currentHost || targetHost === 'localhost' || targetHost === '127.0.0.1';
    } catch {
      return false;
    }
  }

  window.location.assign = function(url) {
    if (isSafeNavigation(url)) {
      originalAssign(url);
    } else {
      console.warn('[AniTAG Shield] Blocked cross-origin redirect to:', url);
    }
  };

  window.location.replace = function(url) {
    if (isSafeNavigation(url)) {
      originalReplace(url);
    } else {
      console.warn('[AniTAG Shield] Blocked cross-origin redirect to:', url);
    }
  };

  // 3. Remove Invisible Clickjack / Popunder Overlays
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          const el = node;
          const tagName = el.tagName.toLowerCase();
          if (tagName === 'iframe' && (el.src.includes('ads') || el.src.includes('pop') || el.src.includes('syndication'))) {
            el.remove();
            console.warn('[AniTAG Shield] Removed ad iframe:', el.src);
          }
          if (tagName === 'div' && el.style && (el.style.zIndex > 9000 || el.style.position === 'fixed')) {
            const opacity = parseFloat(el.style.opacity);
            if (opacity === 0 || el.style.pointerEvents === 'all' && el.children.length === 0) {
              el.remove();
              console.warn('[AniTAG Shield] Removed clickjack overlay');
            }
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 4. Suppress beforeunload and alert spam from malicious embed scripts
  window.addEventListener('beforeunload', function(e) {
    e.stopImmediatePropagation();
  }, true);

  console.log('[AniTAG Shield] Strict Zero-Ad & Zero-Redirect active.');
})();
`;
