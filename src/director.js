// director.js — the scene director.
//
// Instead of the player toggling who is "present" by hand, the story drives the
// roster: characters enter and leave, some are sent elsewhere (a wounded hero
// carried to the Watchtower), and an in-universe clock advances so that *time*
// has consequences — schedule reinforcements for +5 minutes and, if the scene
// takes that long, they actually arrive.
//
// This module is pure logic + prompt builders (no DOM, no network). The app owns
// the world's character database and passes in a `resolve(name) -> id | null`
// so this module never needs to know how characters are stored.

/* ── Scene state ──────────────────────────────────────────────────────────── */

export function newSceneState(presentIds = []) {
  return {
    clock: 0, // in-universe minutes elapsed
    present: [...new Set(presentIds)], // on-stage; may speak/act now
    away: [], // elsewhere (e.g. the Watchtower); not available without time
    pending: [], // scheduled time-gated events: {id, at, text, enter:[id], fired}
    timeline: [], // {at, text} — notable beats, for the panel and "just now"
    justNow: [], // texts of events that fired this step; shown once in next prompt
  };
}

// Defensive: make sure a scene has a well-formed state (migrates old scenes).
export function ensureSceneState(state, presentIds = []) {
  if (!state || typeof state !== 'object') return newSceneState(presentIds);
  return {
    clock: Number.isFinite(state.clock) ? state.clock : 0,
    present: Array.isArray(state.present) ? [...new Set(state.present)] : [...new Set(presentIds)],
    away: Array.isArray(state.away) ? [...new Set(state.away)] : [],
    pending: Array.isArray(state.pending) ? state.pending : [],
    timeline: Array.isArray(state.timeline) ? state.timeline : [],
    justNow: Array.isArray(state.justNow) ? state.justNow : [],
  };
}

const clone = (s) => ({
  clock: s.clock,
  present: [...s.present],
  away: [...s.away],
  pending: s.pending.map((e) => ({ ...e, enter: [...(e.enter || [])] })),
  timeline: [...s.timeline],
  justNow: [...s.justNow],
});

const evId = () => `evt_${Math.random().toString(36).slice(2, 8)}`;

/* ── Clock formatting ─────────────────────────────────────────────────────── */

export function fmtClock(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

/* ── Roster mutations (return new state; used by commands and the auto-director) */

export function addToScene(state, id) {
  const s = clone(state);
  if (!s.present.includes(id)) s.present.push(id);
  s.away = s.away.filter((x) => x !== id);
  return s;
}

export function removeFromScene(state, id) {
  const s = clone(state);
  s.present = s.present.filter((x) => x !== id);
  return s; // stays "nearby/available", just off-stage
}

export function sendAway(state, id) {
  const s = clone(state);
  s.present = s.present.filter((x) => x !== id);
  if (!s.away.includes(id)) s.away.push(id);
  return s;
}

export function bringBack(state, id) {
  return addToScene(state, id);
}

export function advanceClock(state, minutes) {
  const s = clone(state);
  s.clock += Math.max(0, Math.round(Number(minutes) || 0));
  return s;
}

export function schedule(state, { at, text, enter = [] } = {}) {
  const s = clone(state);
  s.pending.push({ id: evId(), at: Math.max(0, Math.round(at)), text: text || '', enter: [...enter], fired: false });
  s.pending.sort((a, b) => a.at - b.at);
  return s;
}

export function cancelPending(state, id) {
  const s = clone(state);
  s.pending = s.pending.filter((e) => e.id !== id);
  return s;
}

// Fire any pending events whose time has come. Their `enter` cast join the scene,
// the beat is logged, and its text is surfaced (once) for the next prompt.
export function fireDueEvents(state) {
  const s = clone(state);
  const fired = [];
  for (const e of s.pending) {
    if (e.fired || e.at > s.clock) continue;
    for (const id of e.enter || []) {
      if (!s.present.includes(id)) s.present.push(id);
      s.away = s.away.filter((x) => x !== id);
    }
    e.fired = true;
    s.timeline.push({ at: s.clock, text: e.text });
    fired.push(e);
  }
  s.pending = s.pending.filter((e) => !e.fired);
  s.justNow = [...s.justNow, ...fired.map((e) => e.text).filter(Boolean)];
  return { state: s, fired };
}

/* ── Applying a director's decision (parsed from the utility model) ─────────── */

export function applyDirection(state, direction, resolve) {
  let s = clone(state);
  const d = direction || {};
  const ids = (names) => (names || []).map((n) => resolve(n)).filter(Boolean);

  if (d.elapsedMinutes) s = advanceClock(s, d.elapsedMinutes);

  for (const id of ids(d.entered)) s = addToScene(s, id);
  for (const id of ids(d.returned)) s = addToScene(s, id);
  for (const id of ids(d.left)) s = removeFromScene(s, id);
  for (const id of ids(d.sentAway)) s = sendAway(s, id);

  for (const ev of d.events || []) {
    const at = s.clock + Math.max(0, Math.round(ev.inMinutes || 0));
    s = schedule(s, { at, text: ev.text || '', enter: (ev.enter || []).map((n) => resolve(n)).filter(Boolean) });
  }
  return s;
}

/* ── Prompt for the utility "director" pass ───────────────────────────────── */

export function buildDirectorMessages({ exchangeText = '', roster = [], present = [], away = [], clock = 0 } = {}) {
  const system =
    `You are the SCENE DIRECTOR for a roleplay. You do not write story or dialogue. ` +
    `You read the latest exchange and report, as strict JSON, how the scene's cast and clock changed.\n\n` +
    `Roster (the only names you may use): ${roster.join(', ') || '(none)'}.\n` +
    `Currently present: ${present.join(', ') || '(none)'}.\n` +
    `Currently elsewhere: ${away.join(', ') || '(none)'}.\n` +
    `In-universe time so far: ${fmtClock(clock)}.\n\n` +
    `Report ONLY what the exchange shows or clearly implies. If nothing changed, use 0 and empty lists. ` +
    `Output ONLY a JSON object, no prose, in exactly this shape:\n` +
    `{"elapsed_minutes":0,"entered":[],"left":[],"sent_away":[],"returned":[],"events":[{"in_minutes":5,"text":"what will happen","enter":["Name"]}]}\n\n` +
    `Meaning: elapsed_minutes = in-universe minutes that passed in this exchange (usually 0-5). ` +
    `entered = names who joined the scene. left = names who stepped out but remain nearby. ` +
    `sent_away = names who left for elsewhere (e.g. carried to medical) and won't be right back. ` +
    `returned = names who came back. events = future consequences that should happen after a delay, ` +
    `each with the in-universe minutes until it happens and any names who arrive then.`;
  const user = `Latest exchange:\n${exchangeText}\n\nReport the scene changes as JSON.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Robustly pull the JSON object out of a model reply and normalize it.
export function parseDirection(text) {
  const empty = { elapsedMinutes: 0, entered: [], left: [], sentAway: [], returned: [], events: [] };
  if (!text || typeof text !== 'string') return empty;
  let raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return empty;
  let obj;
  try { obj = JSON.parse(raw.slice(a, b + 1)); } catch { return empty; }
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const clampMin = (v, hi) => Math.max(0, Math.min(hi, Math.round(Number(v) || 0)));
  const events = Array.isArray(obj.events)
    ? obj.events
        .filter((e) => e && (e.text || e.enter))
        .map((e) => ({ inMinutes: clampMin(e.in_minutes ?? e.inMinutes, 600), text: String(e.text || '').trim(), enter: arr(e.enter) }))
    : [];
  return {
    elapsedMinutes: clampMin(obj.elapsed_minutes ?? obj.elapsedMinutes, 240),
    entered: arr(obj.entered),
    left: arr(obj.left),
    sentAway: arr(obj.sent_away ?? obj.sentAway),
    returned: arr(obj.returned),
    events,
  };
}

/* ── Player-issued directives (deterministic, reliable) ───────────────────── */

const splitNames = (s) => (s || '').split(/,|\band\b|&/i).map((x) => x.trim()).filter(Boolean);

export function parseDirectorCommand(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^\/(\w+)\s*(.*)$/s);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();

  if (cmd === 'time') return { type: 'time' };
  if (cmd === 'scene') return { type: 'scene' };
  if (cmd === 'wait') {
    const mm = rest.match(/(\d+)\s*(h|hr|hour|hours)?/i);
    if (!mm) return { type: 'wait', minutes: 5 };
    let n = parseInt(mm[1], 10);
    if (mm[2]) n *= 60;
    return { type: 'wait', minutes: Math.max(1, n) };
  }
  if (cmd === 'enter' || cmd === 'join') return { type: 'enter', names: splitNames(rest) };
  if (cmd === 'leave' || cmd === 'exit') return { type: 'leave', names: splitNames(rest) };
  if (cmd === 'away') return { type: 'away', names: splitNames(rest) };
  if (cmd === 'back' || cmd === 'return') return { type: 'back', names: splitNames(rest) };
  if (cmd === 'schedule' || cmd === 'in') {
    const mm = rest.match(/^(\d+)\s*(h|hr|hour|hours)?\s*(.*)$/is);
    if (!mm) return null;
    let n = parseInt(mm[1], 10);
    if (mm[2]) n *= 60;
    let body = (mm[3] || '').trim();
    let names = [];
    const colon = body.indexOf(':');
    if (colon !== -1) { names = splitNames(body.slice(colon + 1)); body = body.slice(0, colon).trim(); }
    return { type: 'schedule', minutes: Math.max(0, n), text: body, names };
  }
  return null;
}
