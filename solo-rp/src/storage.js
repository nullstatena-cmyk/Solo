/**
 * Persistence.
 *
 * Everything lives in localStorage. A small "index" holds personas, settings, and
 * lightweight rows for each world and chat (id, name/title, when last touched).
 * Each full world (its cast, lorebook, and fact-store memory) and each full chat
 * (its message tree) is stored under its own key, so a save after a message or a
 * new fact rewrites only that one record, not the whole library. exportAll /
 * importAll bundle the lot into one JSON file for backup — localStorage is easy to
 * wipe by accident.
 */

const INDEX_KEY = 'solo-rp/index/v2';
const chatKey = (id) => `solo-rp/chat/${id}`;
const worldKey = (id) => `solo-rp/world/${id}`;

const store = () => {
  const s = globalThis.localStorage;
  if (!s) throw new Error('localStorage is not available in this environment');
  return s;
};

export function loadIndex() {
  try {
    return JSON.parse(store().getItem(INDEX_KEY)) || null;
  } catch {
    return null;
  }
}

export function saveIndex(index) {
  store().setItem(INDEX_KEY, JSON.stringify(index));
}

export function loadChat(id) {
  try {
    return JSON.parse(store().getItem(chatKey(id)));
  } catch {
    return null;
  }
}

export function saveChat(chat) {
  store().setItem(chatKey(chat.id), JSON.stringify(chat));
}

export function removeChat(id) {
  store().removeItem(chatKey(id));
}

export function loadWorld(id) {
  try {
    return JSON.parse(store().getItem(worldKey(id)));
  } catch {
    return null;
  }
}

export function saveWorld(world) {
  store().setItem(worldKey(world.id), JSON.stringify(world));
}

export function removeWorld(id) {
  store().removeItem(worldKey(id));
}

/** Bundle the index and every world and chat it references into one portable object. */
export function exportAll() {
  const index = loadIndex() || {};
  const worlds = {};
  for (const meta of index.worldMetas || []) {
    const w = loadWorld(meta.id);
    if (w) worlds[meta.id] = w;
  }
  const chats = {};
  for (const meta of index.chatMetas || []) {
    const c = loadChat(meta.id);
    if (c) chats[meta.id] = c;
  }
  return { version: 2, exportedAt: new Date().toISOString(), index, worlds, chats };
}

/** Restore a bundle produced by exportAll, replacing what's there. */
export function importAll(bundle) {
  if (!bundle || typeof bundle !== 'object' || !bundle.index) {
    throw new Error('That file is not a Solo RP backup.');
  }
  saveIndex(bundle.index);
  for (const [id, world] of Object.entries(bundle.worlds || {})) store().setItem(worldKey(id), JSON.stringify(world));
  for (const [id, chat] of Object.entries(bundle.chats || {})) store().setItem(chatKey(id), JSON.stringify(chat));
  return bundle.index;
}

/** Approximate bytes used, so the UI can warn before the ~5MB wall. */
export function usageBytes() {
  let total = 0;
  const s = store();
  for (let i = 0; i < s.length; i += 1) {
    const key = s.key(i);
    if (key && key.startsWith('solo-rp/')) total += (s.getItem(key) || '').length + key.length;
  }
  return total;
}
