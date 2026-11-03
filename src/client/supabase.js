/**
 * AniTAG Supabase Cloud Client & Sync Manager
 * Authoritative user identity: auth.users.id (UUID)
 * Syncs Continue Watching, Watch History, Watchlist, Ratings, and Preferences.
 * Strict guest-mode fallback when unauthenticated or unconfigured.
 */

import { getSupabaseConfig } from './config.js';
import { STORAGE_KEYS, saveItem, loadItem } from './storage.js';

class AniTagSupabaseManager {
  constructor() {
    this.client = null;
    this.user = null;
    this.initialized = false;
    this.authListeners = [];
  }

  async init() {
    if (this.initialized) return;
    const config = getSupabaseConfig();

    if (!config.url || !config.anonKey) {
      // Graceful offline/guest mode
      this.initialized = true;
      return;
    }

    // If @supabase/supabase-js is loaded on window
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      this.client = window.supabase.createClient(config.url, config.anonKey);
      
      const { data: { session } } = await this.client.auth.getSession();
      if (session && session.user) {
        this.user = session.user;
      }

      this.client.auth.onAuthStateChange(async (_event, session) => {
        const prevUser = this.user;
        this.user = session ? session.user : null;
        if (this.user && (!prevUser || prevUser.id !== this.user.id)) {
          await this.pullCloudData();
        }
        this.notifyAuthListeners();
      });
    }

    this.initialized = true;
  }

  onAuthStateChange(callback) {
    if (typeof callback === 'function') {
      this.authListeners.push(callback);
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

  async signInWithGoogle() {
    if (!this.client) {
      console.warn('[Supabase] Supabase client not configured. Running in offline/guest mode.');
      return { error: 'Supabase credentials not configured' };
    }

    const { data, error } = await this.client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin
      }
    });

    if (error) console.error('[Supabase] Google Sign-In error:', error.message);
    return { data, error };
  }

  async signOut() {
    if (this.client) {
      await this.client.auth.signOut();
    }
    this.user = null;
    this.notifyAuthListeners();
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
          animeId: row.anime_id,
          episode: row.episode_num,
          progress: row.progress_seconds,
          duration: row.duration_seconds,
          audioMode: row.audio_mode,
          timestamp: new Date(row.updated_at).getTime()
        }));
        await saveItem(STORAGE_KEYS.CONTINUE_WATCHING, localCw);
      }

      // 3. Pull Watchlist
      const { data: wlData } = await this.client
        .from('user_watchlist')
        .select('anime_id')
        .eq('user_id', uid);

      if (wlData) {
        const wlSet = wlData.map(r => r.anime_id);
        await saveItem(STORAGE_KEYS.BOOKMARKS, wlSet);
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
        anime_id: item.animeId,
        episode_num: item.episode || 1,
        progress_seconds: Math.floor(item.progress || 0),
        duration_seconds: Math.floor(item.duration || 0),
        audio_mode: item.audioMode || 'SUB',
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
