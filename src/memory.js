/**
 * The memory engine.
 *
 * Two background jobs keep a long story coherent, both driven by the model:
 *
 *  - Extraction: after a turn, pull the durable new facts that were revealed, so
 *    they can be filed into the world's fact store (attributed to whoever was
 *    present).
 *  - Summarization: when the running conversation grows past a budget, fold the
 *    older turns into a "story so far" summary and drop them from context, so the
 *    thread can go on effectively forever without losing the plot.
 *
 * The actual model calls live in the app; everything here — parsing the model's
 * output, deciding when to summarize, choosing what to fold in, and reading the
 * user's slash-commands — is pure and tested.
 */

import { activePath } from './tree.js';
import { estimateTokens } from './prompt.js';

/* ── Slash commands ───────────────────────────────────────────────────────── */

const COMMANDS = new Set(['recap', 'whoknows', 'join', 'leave', 'correct', 'remember', 'help']);

/** "/whoknows the plan" → { cmd:'whoknows', arg:'the plan' }; non-commands → null. */
export function parseCommand(input) {
  const m = String(input || '').match(/^\s*\/([a-zA-Z]+)\b\s*(.*)$/s);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  if (!COMMANDS.has(cmd)) return null;
  return { cmd, arg: m[2].trim() };
}

/* ── Fact extraction ──────────────────────────────────────────────────────── */

export function buildExtractionMessages({ exchangeText, castNames = [], knownFactsText = '' } = {}) {
  const roster = castNames.length ? castNames.join(', ') : 'the characters';
  const system =
    'You extract durable story facts for a roleplay memory system. ' +
    'Read the latest exchange and list any NEW, lasting facts it establishes — ' +
    'identities, relationships, decisions, promises, revealed secrets, changes to the world or characters. ' +
    'Ignore mood, small talk, and anything already known. Each fact is one short, self-contained sentence in the third person. ' +
    'Respond with ONLY a JSON object of the form {"facts": ["...", "..."]} and nothing else. If there are no new facts, return {"facts": []}.';

  const user =
    `Characters present: ${roster}\n\n` +
    (knownFactsText ? `Already known (do not repeat):\n${knownFactsText}\n\n` : '') +
    `Latest exchange:\n${exchangeText}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Robustly pull the fact list out of the model's reply (tolerates fences/prose). */
export function parseFactList(text) {
  if (!text) return [];
  let obj = tryJson(text);
  if (!obj) {
    const slice = firstJsonSlice(text);
    if (slice) obj = tryJson(slice);
  }
  let list = [];
  if (Array.isArray(obj)) list = obj;
  else if (obj && Array.isArray(obj.facts)) list = obj.facts;
  return list
    .map((x) => (typeof x === 'string' ? x : x?.text || x?.fact || ''))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

/** Drop incoming facts that duplicate (case/punctuation-insensitive, containment) existing ones. */
export function dedupeFacts(existingTexts, incomingTexts) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const seen = existingTexts.map(norm);
  const out = [];
  for (const inc of incomingTexts) {
    const n = norm(inc);
    if (!n) continue;
    const dup = seen.some((e) => e === n || e.includes(n) || n.includes(e));
    if (!dup) {
      out.push(inc);
      seen.push(n);
    }
  }
  return out;
}

/* ── Summarization ────────────────────────────────────────────────────────── */

/**
 * True when the un-summarized part of the conversation has grown past the budget
 * and there's enough of it to be worth folding down.
 */
export function shouldSummarize(chat, settings = {}) {
  const threshold = settings.summaryThreshold || 2400; // tokens of live convo before folding
  const keepRecent = settings.summaryKeepRecent ?? 6;
  const done = new Set(chat.summarizedIds || []);
  const fresh = activePath(chat).filter((n) => n.parentId != null && !done.has(n.id));
  if (fresh.length <= keepRecent + 2) return false;
  const tokens = fresh.reduce((n, m) => n + estimateTokens(m.content), 0);
  return tokens > threshold;
}

/**
 * Choose what to fold into the summary: the older un-summarized turns, keeping the
 * most recent `keepRecent` live. Returns the nodes to summarize and their ids
 * (which the caller records on the chat so they're dropped from future context).
 */
export function nodesToSummarize(chat, settings = {}) {
  const keepRecent = settings.summaryKeepRecent ?? 6;
  const done = new Set(chat.summarizedIds || []);
  const fresh = activePath(chat).filter((n) => n.parentId != null && !done.has(n.id));
  const fold = fresh.slice(0, Math.max(0, fresh.length - keepRecent));
  return { fold, ids: fold.map((n) => n.id) };
}

export function buildSummaryMessages({ priorSummary = '', transcript = '' } = {}) {
  const system =
    'You maintain a running "story so far" for a long roleplay. ' +
    'Given the previous summary and the next stretch of transcript, produce an updated summary that preserves plot, ' +
    'relationships, commitments, unresolved threads, and any established facts. Keep it tight and in the third person. ' +
    'Return only the summary prose.';
  const user =
    (priorSummary ? `Previous summary:\n${priorSummary}\n\n` : '') +
    `Next transcript to fold in:\n${transcript}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Render selected nodes as a plain transcript for summarization/extraction. */
export function transcriptOf(nodes, { charName = 'Character', userName = 'User' } = {}) {
  return nodes
    .map((n) => `${n.role === 'assistant' ? charName : userName}: ${n.content}`)
    .join('\n');
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Find the first {...} or [...] block in a string. */
function firstJsonSlice(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
