/**
 * AniTAG Client Persistent Storage (IndexedDB + localStorage Fallback)
 * Provides reliable, offline-first client storage for guest users and cached states.
 */

const DB_NAME = 'anitag_db';
const DB_VERSION = 1;
const STORES = {
  PREFERENCES: 'preferences',
  CONTINUE_WATCHING: 'continue_watching',
  WATCH_HISTORY: 'watch_history',
  BOOKMARKS: 'bookmarks'
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  dbPromise = new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        Object.values(STORES).forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            if (storeName === 'CONTINUE_WATCHING') {
              db.createObjectStore(storeName, { keyPath: 'animeId' });
            } else if (storeName === 'WATCH_HISTORY') {
              db.createObjectStore(storeName, { keyPath: 'uid' });
            } else if (storeName === 'BOOKMARKS') {
              db.createObjectStore(storeName, { keyPath: 'animeId' });
            } else {
              db.createObjectStore(storeName, { keyPath: 'key' });
            }
          }
        });
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (err) => {
        console.warn('[AniTAG Storage] IndexedDB open error, falling back to localStorage:', err);
        resolve(null);
      };
    } catch (e) {
      console.warn('[AniTAG Storage] IndexedDB init exception:', e);
      resolve(null);
    }
  });

  return dbPromise;
}

export async function getStorageItem(storeName, key) {
  const db = await openDb();
  if (!db) {
    try {
      const val = localStorage.getItem(`anitag_${storeName}_${key}`);
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setStorageItem(storeName, item) {
  const db = await openDb();
  if (!db) {
    try {
      const key = item.animeId || item.uid || item.key || 'default';
      localStorage.setItem(`anitag_${storeName}_${key}`, JSON.stringify(item));
    } catch (e) {
      console.warn('[AniTAG Storage] localStorage write error:', e);
    }
    return;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(item);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getAllStorageItems(storeName) {
  const db = await openDb();
  if (!db) {
    try {
      const items = [];
      const prefix = `anitag_${storeName}_`;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const raw = localStorage.getItem(k);
          if (raw) items.push(JSON.parse(raw));
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function removeStorageItem(storeName, key) {
  const db = await openDb();
  if (!db) {
    try {
      localStorage.removeItem(`anitag_${storeName}_${key}`);
    } catch {}
    return;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function clearStorageStore(storeName) {
  const db = await openDb();
  if (!db) {
    try {
      const prefix = `anitag_${storeName}_`;
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keysToRemove.push(k);
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {}
    return;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export { STORES };
export const STORAGE_KEYS = STORES;

export async function saveItem(storeName, item) {
  return setStorageItem(storeName, item);
}

export async function loadItem(storeName, key) {
  return getStorageItem(storeName, key);
}

export async function getAllItems(storeName) {
  return getAllStorageItems(storeName);
}

export async function removeItem(storeName, key) {
  return removeStorageItem(storeName, key);
}

export async function clearStore(storeName) {
  return clearStorageStore(storeName);
}
