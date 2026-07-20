/**
 * World tests.  node test/world.test.js
 *
 * The knowledge-gating tests are the important ones: they encode the promise that
 * a fact revealed in a scene is known to exactly who was present, and only surfaces
 * in scenes where one of those characters is around.
 */

import assert from 'node:assert/strict';
import {
  createWorld, createCharacter, addCharacter, addLoreEntry, selectLore, splitKeys,
  addFact, revealToPresent, factsKnownInScene, whoKnows, knownByNames, deleteFact, characterNames,
} from '../src/world.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\nworlds\n');

function peopled() {
  const w = createWorld({ name: 'The Compound' });
  const nat = addCharacter(w, createCharacter({ name: 'Natasha' }));
  const tony = addCharacter(w, createCharacter({ name: 'Tony' }));
  const steve = addCharacter(w, createCharacter({ name: 'Steve' }));
  return { w, nat, tony, steve };
}

/* ── Cast & lore ──────────────────────────────────────────────────────────── */

it('a world starts empty', () => {
  const w = createWorld({ name: 'Test' });
  assert.deepEqual(w.cast, []);
  assert.deepEqual(w.facts, []);
  assert.equal(w.mode, 'new');
});

it('splitKeys parses a comma list', () => {
  assert.deepEqual(splitKeys('kevin, the kid , boy'), ['kevin', 'the kid', 'boy']);
});

it('lore is selected by keyword, and "always" entries always appear', () => {
  const { w } = peopled();
  addLoreEntry(w, { keys: 'reactor, arc reactor', content: 'The arc reactor powers the tower.' });
  addLoreEntry(w, { always: true, content: 'It is winter in this world.' });

  const none = selectLore(w, 'they walk into the room');
  assert.equal(none.length, 1, 'only the always-entry');

  const hit = selectLore(w, 'she checks the ARC REACTOR readings');
  assert.equal(hit.length, 2, 'keyword entry triggers, plus always');
});

it('disabled lore never triggers', () => {
  const { w } = peopled();
  addLoreEntry(w, { keys: 'reactor', content: 'x', enabled: false });
  assert.equal(selectLore(w, 'the reactor hums').length, 0);
});

/* ── Presence-gated knowledge ─────────────────────────────────────────────── */

it('a revealed fact is known to exactly who was present', () => {
  const { w, nat, tony } = peopled();
  revealToPresent(w, 'Kevin is 13 years old.', [nat.id, tony.id]);
  const fact = w.facts[0];
  assert.deepEqual(fact.knownBy.sort(), [nat.id, tony.id].sort());
  assert.equal(fact.everyone, false);
});

it('a scene only sees facts its present cast knows', () => {
  const { w, nat, tony, steve } = peopled();
  revealToPresent(w, "Kevin's age is 13.", [nat.id, tony.id]); // Steve not present

  // A scene with Steve alone knows nothing.
  assert.equal(factsKnownInScene(w, [steve.id]).length, 0);
  // A scene with Tony knows it.
  assert.equal(factsKnownInScene(w, [tony.id]).length, 1);
});

it('telling a new character propagates the fact to them', () => {
  const { w, nat, tony, steve } = peopled();
  revealToPresent(w, 'The base is in New York.', [nat.id, tony.id]);
  // Later scene: Nat tells Steve. Nat + Steve present, fact re-revealed.
  revealToPresent(w, 'The base is in New York.', [nat.id, steve.id]);

  const fact = w.facts[0];
  assert.equal(w.facts.length, 1, 'merged, not duplicated');
  assert.ok(fact.knownBy.includes(steve.id), 'Steve now knows');
  assert.equal(factsKnownInScene(w, [steve.id]).length, 1);
});

it('everyone-facts are known in every scene', () => {
  const { w, steve } = peopled();
  addFact(w, { text: 'Gravity works normally here.', everyone: true });
  assert.equal(factsKnownInScene(w, [steve.id]).length, 1);
});

it('duplicate facts merge and widen knowledge rather than pile up', () => {
  const { w, nat, tony } = peopled();
  addFact(w, { text: 'The password is bluebird.', knownBy: [nat.id] });
  addFact(w, { text: 'the password is BLUEBIRD.', knownBy: [tony.id] }); // same fact, different case
  assert.equal(w.facts.length, 1);
  assert.deepEqual(w.facts[0].knownBy.sort(), [nat.id, tony.id].sort());
});

it('whoKnows reports facts and who holds them', () => {
  const { w, nat } = peopled();
  revealToPresent(w, 'Natasha has a hidden safehouse.', [nat.id]);
  addFact(w, { text: 'The sky is blue.', everyone: true });

  const secret = whoKnows(w, 'safehouse');
  assert.equal(secret.length, 1);
  assert.deepEqual(secret[0].who, ['Natasha']);

  const all = whoKnows(w, '');
  assert.equal(all.length, 2, 'empty query returns everything');
  assert.deepEqual(knownByNames(w, w.facts.find((f) => f.everyone)), ['everyone']);
});

it('characterNames resolves ids, tolerating unknowns', () => {
  const { w, nat } = peopled();
  assert.deepEqual(characterNames(w, [nat.id, 'ghost']), ['Natasha', 'someone']);
});

it('facts can be deleted', () => {
  const { w, nat } = peopled();
  const f = addFact(w, { text: 'temp', knownBy: [nat.id] });
  deleteFact(w, f.id);
  assert.equal(w.facts.length, 0);
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
