/**
 * Worlds.
 *
 * A world is the container that gives roleplay its depth. It holds a *cast* of
 * characters the AI plays (you play your persona), a *lorebook* — the world bible,
 * injected into context only when it's relevant — and a *fact store* that is the
 * persistent, contradiction-free memory.
 *
 * The fact store is the heart of it. Every fact records who knows it, and
 * knowledge is gated by presence: a fact revealed in a scene becomes known to
 * exactly the cast members who were in that scene, and to nobody else until
 * they're told. So if one character tells the room a secret, everyone present
 * learns it going forward, and a character who wasn't there stays in the dark.
 * When a scene is built, only the facts its present cast actually know are handed
 * to the model.
 *
 * All pure and JSON-serializable, so the gating logic is fully testable.
 */

import { makeId } from './tree.js';

const now = () => Date.now();

/* ── Constructors ─────────────────────────────────────────────────────────── */

export function createWorld({ name, mode = 'new', description = '' } = {}) {
  const t = now();
  return {
    id: makeId(),
    name: name || 'New world',
    mode, // 'new' (original) or 'jumpin' (based on existing media)
    description,
    cast: [],
    lorebook: [],
    facts: [],
    createdAt: t,
    updatedAt: t,
  };
}

export function createCharacter(fields = {}) {
  return {
    id: makeId(),
    name: fields.name || 'Unnamed',
    avatar: fields.avatar || '🎭',
    description: fields.description || '',
    personality: fields.personality || '',
    scenario: fields.scenario || '',
    greeting: fields.greeting || '',
    exampleDialogue: fields.exampleDialogue || '',
  };
}

export function createLoreEntry(fields = {}) {
  return {
    id: makeId(),
    name: fields.name || '',
    keys: Array.isArray(fields.keys) ? fields.keys : splitKeys(fields.keys),
    content: fields.content || '',
    always: !!fields.always, // injected every turn regardless of keywords
    enabled: fields.enabled !== false,
  };
}

/** "kevin, the kid, boy" → ["kevin","the kid","boy"] */
export function splitKeys(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const touch = (world) => {
  world.updatedAt = now();
};

/* ── Cast ─────────────────────────────────────────────────────────────────── */

export function addCharacter(world, fields) {
  const c = fields.id && fields.name !== undefined ? fields : createCharacter(fields);
  world.cast.push(c);
  touch(world);
  return c;
}

export const characterById = (world, id) => world.cast.find((c) => c.id === id) || null;

export function characterNames(world, ids) {
  return ids.map((id) => characterById(world, id)?.name || 'someone');
}

/* ── Lorebook ─────────────────────────────────────────────────────────────── */

export function addLoreEntry(world, fields) {
  const e = createLoreEntry(fields);
  world.lorebook.push(e);
  touch(world);
  return e;
}

/**
 * The lore entries that apply to the current moment: every "always" entry, plus
 * any entry whose keywords appear in the recent text. This is the world bible's
 * retrieval — only what's relevant is spent on context.
 */
export function selectLore(world, recentText) {
  const hay = String(recentText || '').toLowerCase();
  return world.lorebook.filter((e) => {
    if (!e.enabled || !e.content) return false;
    if (e.always) return true;
    return e.keys.some((k) => k && hay.includes(k.toLowerCase()));
  });
}

/* ── Facts / memory with presence gating ──────────────────────────────────── */

/**
 * Record a fact. `knownBy` is a list of cast ids; `everyone` marks a world truth
 * that all characters know. Duplicate text (case-insensitive) merges into the
 * existing fact, widening who knows it rather than piling up.
 */
export function addFact(world, { text, knownBy = [], everyone = false, sceneId = null } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const existing = world.facts.find((f) => f.text.toLowerCase() === clean.toLowerCase());
  if (existing) {
    if (everyone) existing.everyone = true;
    for (const id of knownBy) if (!existing.knownBy.includes(id)) existing.knownBy.push(id);
    touch(world);
    return existing;
  }

  const fact = { id: makeId(), text: clean, knownBy: [...new Set(knownBy)], everyone, sceneId, ts: now() };
  world.facts.push(fact);
  touch(world);
  return fact;
}

/** Reveal a fact to everyone present — the propagation rule. */
export function revealToPresent(world, text, presentCast, sceneId = null) {
  return addFact(world, { text, knownBy: presentCast, sceneId });
}

/** The facts the current scene's cast actually know (everyone-facts always included). */
export function factsKnownInScene(world, presentCast) {
  const present = new Set(presentCast);
  return world.facts.filter((f) => f.everyone || f.knownBy.some((id) => present.has(id)));
}

/** Which characters know a given fact, as names (or "everyone"). */
export function knownByNames(world, fact) {
  if (fact.everyone) return ['everyone'];
  return characterNames(world, fact.knownBy);
}

/** Answer "/whoknows <query>": facts matching the query and who holds them. */
export function whoKnows(world, query) {
  const q = String(query || '').toLowerCase().trim();
  const matches = q ? world.facts.filter((f) => f.text.toLowerCase().includes(q)) : world.facts;
  return matches.map((f) => ({ text: f.text, who: knownByNames(world, f) }));
}

export function deleteFact(world, id) {
  world.facts = world.facts.filter((f) => f.id !== id);
  touch(world);
}

export function setFactEveryone(world, id, everyone) {
  const f = world.facts.find((x) => x.id === id);
  if (f) {
    f.everyone = everyone;
    touch(world);
  }
}
