/**
 * Memory-engine tests.  node test/memory.test.js
 */

import assert from 'node:assert/strict';
import { createChat, addMessage } from '../src/tree.js';
import {
  parseCommand, buildExtractionMessages, parseFactList, dedupeFacts,
  shouldSummarize, nodesToSummarize, buildSummaryMessages, transcriptOf,
} from '../src/memory.js';
import { createWorld, createCharacter, addCharacter, addFact, factsKnownInScene, knownByNames } from '../src/world.js';
import { buildWorldMessages, buildWorldSystemPrompt } from '../src/prompt.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\nmemory engine\n');

/* ── Commands ─────────────────────────────────────────────────────────────── */

it('parses slash commands and their arguments', () => {
  assert.deepEqual(parseCommand('/whoknows the plan'), { cmd: 'whoknows', arg: 'the plan' });
  assert.deepEqual(parseCommand('/join Natasha'), { cmd: 'join', arg: 'Natasha' });
  assert.deepEqual(parseCommand('/recap'), { cmd: 'recap', arg: '' });
});

it('ignores non-commands and unknown commands', () => {
  assert.equal(parseCommand('hello there'), null);
  assert.equal(parseCommand('/notacommand x'), null);
  assert.equal(parseCommand('what/ever'), null);
});

/* ── Extraction parsing ───────────────────────────────────────────────────── */

it('extraction messages name the present cast and ask for JSON', () => {
  const msgs = buildExtractionMessages({ exchangeText: 'stuff happened', castNames: ['Nat', 'Tony'] });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /JSON/);
  assert.match(msgs[1].content, /Nat, Tony/);
});

it('parses a clean JSON fact list', () => {
  assert.deepEqual(parseFactList('{"facts":["A is true.","B happened."]}'), ['A is true.', 'B happened.']);
});

it('parses facts even when wrapped in prose or code fences', () => {
  const messy = 'Sure! Here you go:\n```json\n{"facts": ["Kevin is 13."]}\n```\nHope that helps.';
  assert.deepEqual(parseFactList(messy), ['Kevin is 13.']);
});

it('tolerates an empty or malformed reply', () => {
  assert.deepEqual(parseFactList('{"facts":[]}'), []);
  assert.deepEqual(parseFactList('no json here'), []);
  assert.deepEqual(parseFactList(''), []);
});

it('dedupes incoming facts against what is already known', () => {
  const existing = ['Kevin is 13 years old.'];
  const incoming = ['Kevin is 13.', 'Tony trusts Maya.', 'kevin is 13 YEARS old.'];
  const fresh = dedupeFacts(existing, incoming);
  assert.deepEqual(fresh, ['Tony trusts Maya.'], 'only the genuinely new fact survives');
});

/* ── Summarization triggers ───────────────────────────────────────────────── */

function longChat(turns) {
  const chat = createChat({ title: 'long' });
  addMessage(chat, { role: 'assistant', content: 'Opening.', parentId: null });
  for (let i = 0; i < turns; i += 1) {
    addMessage(chat, { role: 'user', content: `User turn ${i} ` + 'x'.repeat(120) });
    addMessage(chat, { role: 'assistant', content: `Reply ${i} ` + 'y'.repeat(120) });
  }
  return chat;
}

it('does not summarize a short conversation', () => {
  assert.equal(shouldSummarize(longChat(2), { summaryThreshold: 2400 }), false);
});

it('summarizes once the live conversation grows past the budget', () => {
  const chat = longChat(20);
  assert.equal(shouldSummarize(chat, { summaryThreshold: 800, summaryKeepRecent: 6 }), true);
});

it('folds the older turns and keeps the recent ones', () => {
  const chat = longChat(20);
  const { fold, ids } = nodesToSummarize(chat, { summaryKeepRecent: 6 });
  assert.ok(fold.length > 0);
  assert.equal(ids.length, fold.length);
  // The last few turns are NOT folded.
  const foldedIds = new Set(ids);
  const tail = Object.values(chat.nodes)
    .sort((a, b) => a.ts - b.ts)
    .slice(-6);
  for (const n of tail) assert.ok(!foldedIds.has(n.id), 'recent turns stay live');
});

it('summary messages carry the prior summary and new transcript', () => {
  const msgs = buildSummaryMessages({ priorSummary: 'They met.', transcript: 'Then they fought.' });
  assert.match(msgs[1].content, /They met\./);
  assert.match(msgs[1].content, /Then they fought\./);
});

it('transcriptOf labels turns by name', () => {
  const chat = createChat();
  addMessage(chat, { role: 'assistant', content: 'Hi.', parentId: null });
  addMessage(chat, { role: 'user', content: 'Hey.' });
  const text = transcriptOf(Object.values(chat.nodes), { charName: 'Vex', userName: 'Hale' });
  assert.match(text, /Vex: Hi\./);
  assert.match(text, /Hale: Hey\./);
});

/* ── World prompt assembly (integration) ──────────────────────────────────── */

it('a scene prompt gates facts by who is present', () => {
  const world = createWorld({ name: 'Compound', description: 'A hero base.' });
  const nat = addCharacter(world, createCharacter({ name: 'Natasha', personality: 'guarded' }));
  const steve = addCharacter(world, createCharacter({ name: 'Steve' }));
  addFact(world, { text: 'Nat has a safehouse in Kiev.', knownBy: [nat.id] });
  addFact(world, { text: 'The tower is in Manhattan.', everyone: true });

  // Scene with Steve only: he should not be handed Nat's secret.
  const gated = factsKnownInScene(world, [steve.id]).map((f) => ({ ...f, knownByNames: knownByNames(world, f) }));
  const sysSteve = buildWorldSystemPrompt({ world, presentCast: [steve], facts: gated });
  assert.match(sysSteve, /tower is in Manhattan/);
  assert.doesNotMatch(sysSteve, /safehouse/, 'Steve-only scene hides the secret');

  // Scene with Nat: the secret is present and attributed.
  const gatedNat = factsKnownInScene(world, [nat.id]).map((f) => ({ ...f, knownByNames: knownByNames(world, f) }));
  const sysNat = buildWorldSystemPrompt({ world, presentCast: [nat], facts: gatedNat });
  assert.match(sysNat, /safehouse in Kiev/);
  assert.match(sysNat, /known by Natasha/);
});

it('buildWorldMessages drops summarized turns and injects the summary', () => {
  const world = createWorld({ name: 'W' });
  const c = addCharacter(world, createCharacter({ name: 'Guide' }));
  const chat = createChat({ title: 's' });
  chat.presentCast = [c.id];
  addMessage(chat, { role: 'assistant', content: 'Old opening.', parentId: null });
  const old = addMessage(chat, { role: 'user', content: 'Old user turn.' });
  addMessage(chat, { role: 'assistant', content: 'Old reply.' });
  const recent = addMessage(chat, { role: 'user', content: 'Recent turn.' });
  chat.summarizedIds = [old.id]; // pretend the old user turn is folded

  const msgs = buildWorldMessages({ chat, world, summary: 'Previously, things happened.' });
  const joined = msgs.map((m) => m.content).join('\n');
  assert.match(joined, /Story so far:\nPreviously, things happened\./);
  assert.match(joined, /Recent turn\./, 'recent turn kept');
  assert.doesNotMatch(joined, /Old user turn\./, 'folded turn dropped');
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
