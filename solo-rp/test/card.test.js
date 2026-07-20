/**
 * Card tests.  node test/card.test.js
 *
 * The PNG test builds a real (tiny) PNG in memory — signature, a tEXt chunk whose
 * value is the base64 of a character JSON, then IEND — and checks it round-trips
 * back out. That's the parser's whole job.
 */

import assert from 'node:assert/strict';
import { normalizeCard, extractCardFromPng } from '../src/card.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\ncharacter cards\n');

/* ── Normalization ────────────────────────────────────────────────────────── */

it('reads a flat v1 card', () => {
  const card = normalizeCard({ name: 'Vex', description: 'engineer', first_mes: 'Hello.', mes_example: 'ex' });
  assert.equal(card.name, 'Vex');
  assert.equal(card.greeting, 'Hello.');
  assert.equal(card.exampleDialogue, 'ex');
});

it('reads a nested v2/v3 card under data', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: 'Nyx', personality: 'cold', scenario: 'a heist' } });
  assert.equal(card.name, 'Nyx');
  assert.equal(card.personality, 'cold');
  assert.equal(card.scenario, 'a heist');
});

it('falls back to the first alternate greeting', () => {
  const card = normalizeCard({ data: { name: 'A', alternate_greetings: ['Hi from the alt list.'] } });
  assert.equal(card.greeting, 'Hi from the alt list.');
});

it('returns null when there is nothing usable', () => {
  assert.equal(normalizeCard({}), null);
  assert.equal(normalizeCard(null), null);
  assert.equal(normalizeCard('nope'), null);
});

/* ── PNG extraction ───────────────────────────────────────────────────────── */

// Build a minimal PNG carrying a `chara` tEXt chunk. CRCs are not validated by
// the reader, so we can leave them zero.
function pngWithCard(cardObj, keyword = 'chara') {
  const enc = new TextEncoder();
  const b64 = Buffer.from(JSON.stringify(cardObj), 'utf-8').toString('base64');
  const textData = [...enc.encode(keyword), 0, ...enc.encode(b64)];

  const chunk = (type, data) => {
    const len = data.length;
    const typeBytes = [...enc.encode(type)];
    return [
      (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
      ...typeBytes,
      ...data,
      0, 0, 0, 0, // CRC placeholder
    ];
  };

  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10, // signature
    ...chunk('tEXt', textData),
    ...chunk('IEND', []),
  ];
  return new Uint8Array(bytes).buffer;
}

it('extracts a card embedded in a PNG', () => {
  const buf = pngWithCard({ data: { name: 'PngChar', description: 'from a png', first_mes: 'Greetings, traveler.' } });
  const card = extractCardFromPng(buf);
  assert.equal(card.name, 'PngChar');
  assert.equal(card.description, 'from a png');
  assert.equal(card.greeting, 'Greetings, traveler.');
});

it('handles unicode in the embedded card', () => {
  const buf = pngWithCard({ name: 'Zoë', description: 'café owner — naïve, résumé in hand 日本語' });
  const card = extractCardFromPng(buf);
  assert.equal(card.name, 'Zoë');
  assert.match(card.description, /café owner/);
  assert.match(card.description, /日本語/);
});

it('prefers a v3 (ccv3) chunk when present', () => {
  const enc = new TextEncoder();
  const chunkOf = (keyword, obj) => {
    const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
    const data = [...enc.encode(keyword), 0, ...enc.encode(b64)];
    const len = data.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...enc.encode('tEXt'), ...data, 0, 0, 0, 0];
  };
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunkOf('chara', { name: 'OldV2' }),
    ...chunkOf('ccv3', { data: { name: 'NewV3' } }),
    0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0,
  ];
  const card = extractCardFromPng(new Uint8Array(bytes).buffer);
  assert.equal(card.name, 'NewV3');
});

it('rejects a non-PNG', () => {
  assert.throws(() => extractCardFromPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer), /not a PNG/);
});

it('reports a PNG with no card', () => {
  const enc = new TextEncoder();
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
  assert.throws(() => extractCardFromPng(new Uint8Array(bytes).buffer), /No character card/);
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
