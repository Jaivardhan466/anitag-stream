/**
 * AniTAG Client Environment & API Configuration
 * Supports Web, Windows Desktop (Electron), and Android (WebViewAssetLoader / file://).
 */

export function getApiBaseUrl() {
  // If explicitly overridden via global config
  if (typeof window !== 'undefined' && window.ANITAG_CONFIG && window.ANITAG_CONFIG.API_BASE_URL) {
    return window.ANITAG_CONFIG.API_BASE_URL;
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:4000';
  }

  // Android WebViewAssetLoader secure origin
  if (window.location.origin === 'https://appassets.androidplatform.net' || window.location.protocol === 'file:') {
    return 'https://anitag-stream.onrender.com';
  }

  // Windows Desktop Electron / Local Dev Server
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `${window.location.protocol}//${window.location.host}`;
  }

  // Production Web (Render or custom domain)
  return window.location.origin;
}

export function getWsSyncUrl() {
  const apiBase = getApiBaseUrl();
  try {
    const parsed = new URL(apiBase);
    const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${parsed.host}/ws/sync`;
  } catch {
    return 'wss://anitag-stream.onrender.com/ws/sync';
  }
}

export function getSupabaseConfig() {
  if (typeof window !== 'undefined' && window.ANITAG_CONFIG && window.ANITAG_CONFIG.SUPABASE_URL) {
    return {
      url: window.ANITAG_CONFIG.SUPABASE_URL,
      anonKey: window.ANITAG_CONFIG.SUPABASE_ANON_KEY || ''
    };
  }
  return {
    url: '',
    anonKey: ''
  };
}
