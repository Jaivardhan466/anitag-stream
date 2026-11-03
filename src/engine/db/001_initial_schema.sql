-- =========================================================================
-- AniTAG Supabase Schema - Initial Production Migration (001_initial_schema.sql)
-- Architecture: Supabase Free Tier + PostgreSQL with Row Level Security (RLS)
-- Authoritative User Identity: auth.users.id (UUID)
-- ABSOLUTE RULE: 0% Purple across all design system theme checks
-- =========================================================================

-- Enable pgcrypto for UUID generation if not present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------------------------
-- 1. PROFILES TABLE
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- 2. USER PREFERENCES (Theme, Audio Mode, Player Settings)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    theme_id TEXT DEFAULT 'monochrome' CHECK (theme_id IN ('monochrome', 'midnight_crimson', 'electric_orange', 'ocean_teal', 'sakura_dusk')),
    theme_mode TEXT DEFAULT 'dark' CHECK (theme_mode IN ('dark', 'light')),
    audio_mode TEXT DEFAULT 'SUB' CHECK (audio_mode IN ('SUB', 'DUB')),
    auto_skip_intro BOOLEAN DEFAULT TRUE,
    sub_size INT DEFAULT 17,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- 3. CONTINUE WATCHING (Cross-Device Sync: Android, Windows, Web)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.continue_watching (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    anime_id TEXT NOT NULL,
    episode_num INT NOT NULL,
    progress_seconds INT NOT NULL DEFAULT 0,
    duration_seconds INT NOT NULL DEFAULT 0,
    audio_mode TEXT DEFAULT 'SUB' CHECK (audio_mode IN ('SUB', 'DUB')),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, anime_id)
);

-- -------------------------------------------------------------------------
-- 4. WATCH HISTORY (Chronological stream log)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watch_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    anime_id TEXT NOT NULL,
    episode_num INT NOT NULL,
    watched_at TIMESTAMPTZ DEFAULT NOW(),
    completed BOOLEAN DEFAULT FALSE
);

-- -------------------------------------------------------------------------
-- 5. USER WATCHLIST / BOOKMARKS
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    anime_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, anime_id)
);

-- -------------------------------------------------------------------------
-- 6. ANIME-LEVEL USER RATINGS
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_anime_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    anime_id TEXT NOT NULL,
    rating NUMERIC(3, 1) NOT NULL CHECK (rating >= 1.0 AND rating <= 10.0),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, anime_id)
);

-- -------------------------------------------------------------------------
-- 7. EPISODE-LEVEL USER RATINGS (Preserved Granularity)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_episode_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    anime_id TEXT NOT NULL,
    episode_num INT NOT NULL,
    rating NUMERIC(3, 1) NOT NULL CHECK (rating >= 1.0 AND rating <= 10.0),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, anime_id, episode_num)
);

-- -------------------------------------------------------------------------
-- INDEXES FOR FAST QUERY EXECUTION
-- -------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_continue_watching_user ON public.continue_watching(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_history_user ON public.watch_history(user_id, watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON public.user_watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_anime_ratings ON public.user_anime_ratings(anime_id);
CREATE INDEX IF NOT EXISTS idx_episode_ratings ON public.user_episode_ratings(anime_id, episode_num);

-- -------------------------------------------------------------------------
-- ROW LEVEL SECURITY (RLS) POLICIES
-- Strict Isolation: Users can NEVER access or mutate another user's rows.
-- -------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.continue_watching ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watch_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_anime_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_episode_ratings ENABLE ROW LEVEL SECURITY;

-- Profiles: Anyone can view display name/avatar; only owner can update
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Preferences: Private to owner
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
CREATE POLICY "Users can view own preferences" ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences" ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences" ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);

-- Continue Watching: Private to owner
DROP POLICY IF EXISTS "Users can view own continue watching" ON public.continue_watching;
CREATE POLICY "Users can view own continue watching" ON public.continue_watching FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own continue watching" ON public.continue_watching;
CREATE POLICY "Users can insert own continue watching" ON public.continue_watching FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own continue watching" ON public.continue_watching;
CREATE POLICY "Users can update own continue watching" ON public.continue_watching FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own continue watching" ON public.continue_watching;
CREATE POLICY "Users can delete own continue watching" ON public.continue_watching FOR DELETE USING (auth.uid() = user_id);

-- Watch History: Private to owner
DROP POLICY IF EXISTS "Users can view own history" ON public.watch_history;
CREATE POLICY "Users can view own history" ON public.watch_history FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own history" ON public.watch_history;
CREATE POLICY "Users can insert own history" ON public.watch_history FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own history" ON public.watch_history;
CREATE POLICY "Users can delete own history" ON public.watch_history FOR DELETE USING (auth.uid() = user_id);

-- Watchlist: Private to owner
DROP POLICY IF EXISTS "Users can view own watchlist" ON public.user_watchlist;
CREATE POLICY "Users can view own watchlist" ON public.user_watchlist FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert into own watchlist" ON public.user_watchlist;
CREATE POLICY "Users can insert into own watchlist" ON public.user_watchlist FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete from own watchlist" ON public.user_watchlist;
CREATE POLICY "Users can delete from own watchlist" ON public.user_watchlist FOR DELETE USING (auth.uid() = user_id);

-- Anime Ratings
DROP POLICY IF EXISTS "Users can view all anime ratings" ON public.user_anime_ratings;
CREATE POLICY "Users can view all anime ratings" ON public.user_anime_ratings FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can manage own anime ratings" ON public.user_anime_ratings;
CREATE POLICY "Users can manage own anime ratings" ON public.user_anime_ratings FOR ALL USING (auth.uid() = user_id);

-- Episode Ratings
DROP POLICY IF EXISTS "Users can view all episode ratings" ON public.user_episode_ratings;
CREATE POLICY "Users can view all episode ratings" ON public.user_episode_ratings FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can manage own episode ratings" ON public.user_episode_ratings;
CREATE POLICY "Users can manage own episode ratings" ON public.user_episode_ratings FOR ALL USING (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- AUTOMATIC SIGNUP TRIGGER: Populate profile & preferences on auth.users insert
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', 'AniTAG Viewer'),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture', '')
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Enable Realtime publication for synchronized tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.continue_watching;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_watchlist;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_preferences;
