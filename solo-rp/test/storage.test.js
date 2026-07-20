/**
 * Storage tests — against an in-memory localStorage, so they run under Node.
 *
 *   node test/storage.test.js
 */

import assert from 'node:assert/strict';

class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  key(i) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
globalThis.localStorage = new MemStore();

const {
  loadIndex, saveIndex, loadChat, saveChat, removeChat,
  loadWorld, saveWorld, removeWorld, exportAll, importAll, usageBytes,
} = await import('../src/storage.js');

let passed = 0;
const failures = [];
function it(name, fn) {
  try { fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

console.log('\nstorage\n');

it('a fresh store has no index', () => {
  assert.equal(loadIndex(), null);
});

it('the index round-trips', () => {
  const index = { personas: [], settings: { model: 'm' }, worldMetas: [], chatMetas: [] };
  saveIndex(index);
  assert.deepEqual(loadIndex(), index);
});

it('worlds are stored under their own keys', () => {
  const world = { id: 'w1', name: 'Compound', cast: [], lorebook: [], facts: [] };
  saveWorld(world);
  assert.deepEqual(loadWorld('w1'), world);
  assert.equal(loadWorld('missing'), null);
});

it('chats are stored under their own keys', () => {
  const chat = { id: 'chat1', title: 'A', nodes: {}, rootId: null };
  saveChat(chat);
  assert.deepEqual(loadChat('chat1'), chat);
});

it('removing works for chats and worlds', () => {
  saveChat({ id: 'temp', title: 'x' });
  removeChat('temp');
  assert.equal(loadChat('temp'), null);
  saveWorld({ id: 'tempw', name: 'x' });
  removeWorld('tempw');
  assert.equal(loadWorld('tempw'), null);
});

it('exportAll gathers the index, worlds, and chats it references', () => {
  globalThis.localStorage = new MemStore();
  saveIndex({ personas: [], settings: {}, worldMetas: [{ id: 'w1' }], chatMetas: [{ id: 'c1' }, { id: 'c2' }] });
  saveWorld({ id: 'w1', name: 'World One' });
  saveChat({ id: 'c1', title: 'One' });
  saveChat({ id: 'c2', title: 'Two' });
  const bundle = exportAll();
  assert.equal(bundle.version, 2);
  assert.deepEqual(Object.keys(bundle.worlds), ['w1']);
  assert.deepEqual(Object.keys(bundle.chats).sort(), ['c1', 'c2']);
  assert.equal(bundle.worlds.w1.name, 'World One');
});

it('importAll restores a bundle', () => {
  globalThis.localStorage = new MemStore();
  const bundle = {
    version: 2,
    index: { personas: [], settings: {}, worldMetas: [{ id: 'w' }], chatMetas: [{ id: 'k' }] },
    worlds: { w: { id: 'w', name: 'Restored world' } },
    chats: { k: { id: 'k', title: 'Recovered' } },
  };
  importAll(bundle);
  assert.equal(loadWorld('w').name, 'Restored world');
  assert.equal(loadChat('k').title, 'Recovered');
});

it('importAll rejects junk', () => {
  assert.throws(() => importAll({ nonsense: true }), /not a Solo RP backup/);
  assert.throws(() => importAll(null), /not a Solo RP backup/);
});

it('usageBytes counts only this app’s keys', () => {
  globalThis.localStorage = new MemStore();
  saveIndex({ worldMetas: [], chatMetas: [] });
  globalThis.localStorage.setItem('unrelated', 'x'.repeat(1000));
  const bytes = usageBytes();
  assert.ok(bytes > 0 && bytes < 1000);
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
