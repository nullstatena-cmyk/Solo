/**
 * Turning a chat into the messages the model sees.
 *
 * The system message is assembled from the character (description, personality,
 * scenario, example dialogue) and the persona the human is playing, with the
 * usual {{char}} / {{user}} placeholders filled in. Then the active path becomes
 * the conversation. If the whole thing is over the context budget, the oldest
 * turns are dropped — but never the system message and never the newest turn.
 *
 * Pure and deterministic, so the exact prompt can be asserted in tests.
 */

import { activePath, apiRole } from './tree.js';

/** Fill {{char}} and {{user}} (and the {{name}} spellings) throughout a string. */
export function fillPlaceholders(text, { charName, userName }) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{char\}\}/gi, charName || 'the character')
    .replace(/\{\{user\}\}/gi, userName || 'You')
    .replace(/<char>/gi, charName || 'the character')
    .replace(/<user>/gi, userName || 'You');
}

/** Rough token estimate. Good enough for trimming; not billing. */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

export function buildSystemPrompt({ character = {}, persona = null, settings = {} }) {
  const names = { charName: character.name, userName: persona?.name };
  const parts = [];

  if (settings.systemPrefix) parts.push(settings.systemPrefix.trim());

  if (character.name) {
    const desc = character.description ? ` ${character.description}` : '';
    parts.push(`You are ${character.name}, and you stay in character.${desc}`);
  } else if (character.description) {
    parts.push(character.description);
  }

  if (character.personality) parts.push(`${character.name || 'Character'}'s personality: ${character.personality}`);
  if (character.scenario) parts.push(`Scenario: ${character.scenario}`);

  if (persona?.name) {
    const pdesc = persona.description ? ` ${persona.description}` : '';
    parts.push(`You are writing for ${character.name || 'your character'} opposite ${persona.name}, who is played by the user.${pdesc}`);
  }

  if (character.exampleDialogue) {
    parts.push(`Example of how ${character.name || 'the character'} speaks:\n${character.exampleDialogue}`);
  }

  return fillPlaceholders(parts.filter(Boolean).join('\n\n'), names).trim();
}

/**
 * Drop the oldest conversation turns until the estimate fits the budget. The
 * system message (index 0) is pinned, and at least the final turn always stays so
 * there's something to answer.
 */
export function trimToBudget(messages, budgetTokens) {
  if (!budgetTokens || budgetTokens <= 0) return messages;
  const total = (list) => list.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const convo = messages.slice(system.length);

  while (convo.length > 1 && total([...system, ...convo]) > budgetTokens) {
    convo.shift();
  }
  return [...system, ...convo];
}

/** The full pipeline: chat → messages ready to POST. */
export function buildApiMessages({ chat, character = {}, persona = null, settings = {} }) {
  const names = { charName: character.name, userName: persona?.name };
  const messages = [];

  const system = buildSystemPrompt({ character, persona, settings });
  if (system) messages.push({ role: 'system', content: system });

  for (const node of activePath(chat)) {
    const role = apiRole(node.role);
    if (role === 'system') continue;
    messages.push({ role, content: fillPlaceholders(node.content, names) });
  }

  return trimToBudget(messages, settings.contextTokens);
}

/* ── World-aware prompt building ──────────────────────────────────────────── */

/**
 * Assemble the system prompt for a scene inside a world: the world itself, the
 * present cast (all of whom the model plays), the persona (the human), the running
 * "story so far" summary, the lore entries that the recent text triggered, and —
 * crucially — only the facts the present cast actually know, grouped so the model
 * can honor who-knows-what.
 */
export function buildWorldSystemPrompt({ world, presentCast = [], persona = null, settings = {}, lore = [], facts = [] }) {
  const parts = [];
  const names = { charName: presentCast.map((c) => c.name).join(' and ') || 'the cast', userName: persona?.name };

  if (settings.systemPrefix) parts.push(settings.systemPrefix.trim());

  const worldLine = world?.name ? `World: ${world.name}.` : '';
  const modeLine =
    world?.mode === 'jumpin'
      ? ` This world is based on an existing setting — honor its established canon and characters.`
      : '';
  if (worldLine || world?.description) parts.push(`${worldLine}${modeLine}${world?.description ? ` ${world.description}` : ''}`.trim());

  if (presentCast.length) {
    const cast = presentCast
      .map((c) => {
        const bits = [c.description, c.personality ? `Personality: ${c.personality}` : ''].filter(Boolean).join(' ');
        return `• ${c.name}${bits ? ` — ${bits}` : ''}`;
      })
      .join('\n');
    const who = presentCast.map((c) => c.name).join(', ');
    parts.push(
      `You play every one of the following characters, and narrate the scene around them. Never write for the user's character.\nPresent in this scene: ${who}.\n${cast}`
    );
  }

  if (persona?.name) {
    parts.push(`The user plays ${persona.name}.${persona.description ? ` ${persona.description}` : ''}`);
  }

  if (lore.length) {
    parts.push(`World details:\n${lore.map((e) => `• ${e.content}`).join('\n')}`);
  }

  if (facts.length) {
    const everyone = facts.filter((f) => f.everyone);
    const restricted = facts.filter((f) => !f.everyone);
    const lines = [];
    if (everyone.length) lines.push(`Known to all present:\n${everyone.map((f) => `• ${f.text}`).join('\n')}`);
    if (restricted.length) {
      lines.push(
        `Known only to specific characters (do not let anyone else act on these):\n${restricted
          .map((f) => `• ${f.text} — known by ${(f.knownByNames || []).join(', ') || 'someone present'}`)
          .join('\n')}`
      );
    }
    parts.push(`Established facts (memory). Stay consistent with these:\n${lines.join('\n\n')}`);
  }

  return fillPlaceholders(parts.filter(Boolean).join('\n\n'), names).trim();
}

/**
 * Build the messages for a world scene. Turns already folded into the summary
 * (ts at/under the watermark) are dropped from the transcript — the summary stands
 * in for them — and the rest is budget-trimmed as usual.
 */
export function buildWorldMessages({ chat, world, persona = null, settings = {}, lore = [], facts = [], summary = '' }) {
  const presentCast = (chat.presentCast || []).map((id) => world.cast.find((c) => c.id === id)).filter(Boolean);
  const names = { charName: presentCast.map((c) => c.name).join(' and ') || 'the cast', userName: persona?.name };
  const messages = [];

  let system = buildWorldSystemPrompt({ world, presentCast, persona, settings, lore, facts });
  if (summary) system += `\n\nStory so far:\n${summary}`;
  if (system) messages.push({ role: 'system', content: system });

  const done = new Set(chat.summarizedIds || []);
  for (const node of activePath(chat)) {
    if (apiRole(node.role) === 'system') continue;
    if (node.parentId != null && done.has(node.id)) continue; // folded into the summary
    messages.push({ role: apiRole(node.role), content: fillPlaceholders(node.content, names) });
  }

  return trimToBudget(messages, settings.contextTokens);
}
