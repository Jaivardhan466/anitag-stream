/**
 * AniTAG Supabase Cloud Client & Sync Manager
 * Authoritative user identity: auth.users.id (UUID)
 * Syncs Continue Watching, Watch History, Watchlist, Ratings, and Preferences.
 * Strict guest-mode fallback when unauthenticated or unconfigured.
 * Seamless Guest-to-Account data migration without losing local data.
 */

import { getSupabaseConfig, getAuthRedirectUrl } from './config.js';
import { STORAGE_KEYS, saveItem, loadItem } from './storage.js';

class AniTagSupabaseManager {
  constructor() {
    this.client = null;
    this.user = null;
    this.initialized = false;
    this.isGuest = true;
    this.authListeners = [];
  }

  async init() {
    if (this.initialized) return;
    const config = getSupabaseConfig();

    if (!config.url || !config.anonKey) {
      // Graceful offline/guest mode - zero errors
      this.isGuest = true;
      this.initialized = true;
      return;
    }

    // Initialize @supabase/supabase-js client if loaded on window
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      try {
        this.client = window.supabase.createClient(config.url, config.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: window.localStorage
          }
        });

        // 1. Initial Session Check (and OAuth Callback parsing)
        const { data: { session }, error: sessionErr } = await this.client.auth.getSession();
        if (sessionErr) {
          console.warn('[Supabase] Stored session check error:', sessionErr.message);
        }

        if (session && session.user) {
          this.user = session.user;
          this.isGuest = false;

          // Clean up OAuth tokens from URL hash or search params without page reload
          if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
            const hasAuthParams = window.location.hash.includes('access_token') ||
                                  window.location.hash.includes('error') ||
                                  window.location.search.includes('code=');
            if (hasAuthParams) {
              const cleanUrl = window.location.pathname + window.location.search.replace(/([&?])code=[^&]+/, '').replace(/^&/, '?');
              window.history.replaceState({}, document.title, cleanUrl || window.location.pathname);
            }
          }

          // Migrate local guest data to account upon first detected session
          await this.syncGuestDataToAccount();
          await this.pullCloudData();
        }

        // 2. Auth State Change Listener (Login, Logout, Token Refresh)
        this.client.auth.onAuthStateChange(async (event, session) => {
          const prevUser = this.user;
          if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
            this.user = session ? session.user : null;
            this.isGuest = !this.user;
            if (this.user && (!prevUser || prevUser.id !== this.user.id)) {
              await this.syncGuestDataToAccount();
              await this.pullCloudData();
            }
          } else if (event === 'SIGNED_OUT') {
            this.user = null;
            this.isGuest = true;
            if (prevUser && window.showToast) {
              window.showToast('Your session has ended. You are now in guest mode.', 'info');
            }
          }
          this.notifyAuthListeners();
        });
      } catch (err) {
        console.warn('[Supabase] Initialization failed, operating in guest mode:', err.message);
        this.isGuest = true;
      }
    }

    this.initialized = true;
    this.notifyAuthListeners();
  }

  onAuthStateChange(callback) {
    if (typeof callback === 'function') {
      this.authListeners.push(callback);
      // Immediately call with current state if already initialized
      if (this.initialized) {
        try { callback(this.user); } catch (e) { console.error('[Supabase] Auth listener error:', e); }
      }
    }
  }

  notifyAuthListeners() {
    this.authListeners.forEach(cb => {
      try { cb(this.user); } catch (e) { console.error('[Supabase] Auth listener error:', e); }
    });
  }

  isAuthenticated() {
    return !!(this.user && this.user.id);
  }

  getUserId() {
    return this.user ? this.user.id : null;
  }

  getUserEmail() {
    return this.user ? this.user.email : null;
  }

  getUserDisplayName() {
    if (!this.user) return 'Guest';
    return this.user.user_metadata?.full_name ||
           this.user.user_metadata?.name ||
           this.user.email?.split('@')[0] ||
           'Account';
  }

  getUserAvatar() {
    if (!this.user) return '';
    return this.user.user_metadata?.avatar_url ||
           this.user.user_metadata?.picture ||
           '';
  }

  /**
   * Genuine Google OAuth Sign-In via Supabase Auth
   * Zero fabricated emails or mock states.
   */
  async signInWithGoogle() {
    if (!this.client) {
      const msg = 'Authentication unavailable: Supabase credentials are not configured.';
      console.warn(`[Supabase] ${msg}`);
      if (typeof window !== 'undefined' && window.showToast) {
        window.showToast(msg, 'error');
      }
      return { error: msg };
    }

    try {
      const redirectTo = getAuthRedirectUrl();
      const { data, error } = await this.client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent'
          }
        }
      });

      if (error) {
        console.error('[Supabase] Google Sign-In error:', error.message);
        if (typeof window !== 'undefined' && window.showToast) {
          window.showToast(`Login failed: ${error.message}`, 'error');
        }
        return { error: error.message };
      }

      return { data };
    } catch (err) {
      console.error('[Supabase] Google Sign-In exception:', err);
      if (typeof window !== 'undefined' && window.showToast) {
        window.showToast(`Login failed: ${err.message}`, 'error');
      }
      return { error: err.message };
    }
  }

  /**
   * Explicit Sign Out
   */
  async signOut() {
    if (this.client) {
      try {
        await this.client.auth.signOut();
      } catch (e) {
        console.warn('[Supabase] Sign-out warning:', e.message);
      }
    }
    this.user = null;
    this.isGuest = true;
    this.notifyAuthListeners();
    if (typeof window !== 'undefined' && window.showToast) {
      window.showToast('Successfully signed out.');
    }
  }

  // -------------------------------------------------------------------------
  // GUEST-TO-ACCOUNT SEAMLESS DATA MIGRATION
  // -------------------------------------------------------------------------

  /**
   * Merges local guest IndexedDB/localStorage data into the authenticated user's account
   * without losing any local bookmarks, history, or preferences.
   */
  async syncGuestDataToAccount() {
    if (!this.isAuthenticated() || !this.client) return;
    const uid = this.getUserId();

    try {
      // 1. Merge Local Watchlist / Bookmarks
      const localWl = (typeof window !== 'undefined' && window.state && window.state.watchlist)
        ? [...window.state.watchlist]
        : (await loadItem(STORAGE_KEYS.BOOKMARKS, 'all') || []);

      if (Array.isArray(localWl)) {
        for (const animeId of localWl) {
          if (animeId) {
            await this.client.from('user_watchlist').upsert({
              user_id: uid,
              anime_id: String(animeId)
            }, { onConflict: 'user_id,anime_id' });
          }
        }
      }

      // 2. Merge Local Continue Watching
      const localCw = (typeof window !== 'undefined' && window.state && window.state.continueWatching)
        ? window.state.continueWatching
        : (await loadItem(STORAGE_KEYS.CONTINUE_WATCHING, 'all') || []);

      if (Array.isArray(localCw)) {
        for (const item of localCw) {
          const aId = item.animeId || item.id;
          if (aId) {
            await this.client.from('continue_watching').upsert({
              user_id: uid,
              anime_id: String(aId),
              episode_num: Number(item.episode || item.ep || 1),
              progress_seconds: Math.floor(item.progress || item.timeSec || 0),
              duration_seconds: Math.floor(item.duration || item.totalSec || 0),
              audio_mode: item.audioMode || item.audio || 'SUB',
              updated_at: new Date(item.timestamp || Date.now()).toISOString()
            }, { onConflict: 'user_id,anime_id' });
          }
        }
      }

      // 3. Merge Local Preferences
      const themeId = localStorage.getItem('anitag_theme_id') || 'monochrome';
      const themeMode = localStorage.getItem('anitag_theme_mode') || 'dark';
      const audioMode = localStorage.getItem('anitag_audio_mode') || 'SUB';

      await this.client.from('user_preferences').upsert({
        user_id: uid,
        theme_id: themeId,
        theme_mode: themeMode,
        audio_mode: audioMode,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
    } catch (err) {
      console.warn('[Supabase] Guest data migration error:', err.message);
    }
  }

  // -------------------------------------------------------------------------
  // CLOUD SYNC & REPLICATION
  // -------------------------------------------------------------------------

  async pullCloudData() {
    if (!this.isAuthenticated() || !this.client) return;

    try {
      const uid = this.getUserId();

      // 1. Pull Preferences
      const { data: prefData } = await this.client
        .from('user_preferences')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle();

      if (prefData) {
        if (prefData.theme_id) localStorage.setItem('anitag_theme_id', prefData.theme_id);
        if (prefData.theme_mode) localStorage.setItem('anitag_theme_mode', prefData.theme_mode);
        if (prefData.audio_mode) localStorage.setItem('anitag_audio_mode', prefData.audio_mode);
      }

      // 2. Pull Continue Watching
      const { data: cwData } = await this.client
        .from('continue_watching')
        .select('*')
        .eq('user_id', uid)
        .order('updated_at', { ascending: false });

      if (cwData && cwData.length > 0) {
        const localCw = cwData.map(row => ({
          id: row.anime_id,
          animeId: row.anime_id,
          ep: row.episode_num,
          episode: row.episode_num,
          timeSec: row.progress_seconds,
          progress: row.progress_seconds,
          totalSec: row.duration_seconds,
          duration: row.duration_seconds,
          audio: row.audio_mode,
          audioMode: row.audio_mode,
          timestamp: new Date(row.updated_at).getTime()
        }));

        await saveItem(STORAGE_KEYS.CONTINUE_WATCHING, localCw);
        if (typeof window !== 'undefined' && window.state) {
          window.state.continueWatching = localCw;
          if (window.renderContinueWatching) window.renderContinueWatching();
        }
      }

      // 3. Pull Watchlist
      const { data: wlData } = await this.client
        .from('user_watchlist')
        .select('anime_id')
        .eq('user_id', uid);

      if (wlData) {
        const wlSet = wlData.map(r => r.anime_id);
        await saveItem(STORAGE_KEYS.BOOKMARKS, wlSet);
        if (typeof window !== 'undefined' && window.state) {
          window.state.watchlist = new Set(wlSet);
          const badge = document.getElementById('watchlistCountBadge');
          if (badge) badge.textContent = window.state.watchlist.size;
        }
      }
    } catch (err) {
      console.warn('[Supabase Sync] Pull error:', err.message);
    }
  }

  async pushContinueWatching(item) {
    if (!this.isAuthenticated() || !this.client) return;

    try {
      await this.client.from('continue_watching').upsert({
        user_id: this.getUserId(),
        anime_id: item.animeId || item.id,
        episode_num: item.episode || item.ep || 1,
        progress_seconds: Math.floor(item.progress || item.timeSec || 0),
        duration_seconds: Math.floor(item.duration || item.totalSec || 0),
        audio_mode: item.audioMode || item.audio || 'SUB',
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,anime_id' });
    } catch (err) {
      console.warn('[Supabase Sync] Push Continue Watching error:', err.message);
    }
  }

  async pushRating(animeId, rating, episodeNum = null) {
    if (!this.isAuthenticated() || !this.client) return;

    try {
      if (episodeNum !== null) {
        // Episode-level rating
        await this.client.from('user_episode_ratings').upsert({
          user_id: this.getUserId(),
          anime_id: animeId,
          episode_num: episodeNum,
          rating: Number(rating),
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,anime_id,episode_num' });
      } else {
        // Anime-level rating
        await this.client.from('user_anime_ratings').upsert({
          user_id: this.getUserId(),
          anime_id: animeId,
          rating: Number(rating),
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,anime_id' });
      }
    } catch (err) {
      console.warn('[Supabase Sync] Push Rating error:', err.message);
    }
  }

  async pushWatchlistToggle(animeId, isAdded) {
    if (!this.isAuthenticated() || !this.client) return;

    try {
      if (isAdded) {
        await this.client.from('user_watchlist').upsert({
          user_id: this.getUserId(),
          anime_id: animeId
        }, { onConflict: 'user_id,anime_id' });
      } else {
        await this.client.from('user_watchlist')
          .delete()
          .eq('user_id', this.getUserId())
          .eq('anime_id', animeId);
      }
    } catch (err) {
      console.warn('[Supabase Sync] Watchlist toggle error:', err.message);
    }
  }
}

export const aniTagCloud = new AniTagSupabaseManager();
if (typeof window !== 'undefined') {
  window.aniTagCloud = aniTagCloud;
}
