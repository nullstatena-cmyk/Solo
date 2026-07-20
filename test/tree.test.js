/**
 * Tree tests.
 *
 * This is where "works the first time" is earned. Every edit/regenerate/branch/
 * swipe/delete operation is exercised here against the real functions the UI
 * calls, so the interesting behaviour is proven before any DOM is involved.
 *
 *   node test/tree.test.js
 */

import assert from 'node:assert/strict';
import {
  createChat, addMessage, activePath, leafId, regenerate, editInPlace, editBranch,
  cycleSibling, siblingInfo, deleteNode, pathTo, branchChat,
} from '../src/tree.js';

let passed = 0;
const failures = [];
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`);
  }
}

const contents = (chat) => activePath(chat).map((n) => n.content);
const roles = (chat) => activePath(chat).map((n) => n.role);

// A small helper: build a chat with a greeting and one user/assistant exchange.
function seeded() {
  const chat = createChat({ title: 'T' });
  addMessage(chat, { role: 'assistant', content: 'Hello there.', parentId: null }); // root greeting
  addMessage(chat, { role: 'user', content: 'Hi.' });
  addMessage(chat, { role: 'assistant', content: 'How are you?' });
  return chat;
}

console.log('\nmessage tree\n');

/* ── Building ─────────────────────────────────────────────────────────────── */

it('a new chat is empty', () => {
  const chat = createChat();
  assert.equal(chat.rootId, null);
  assert.deepEqual(activePath(chat), []);
  assert.equal(leafId(chat), null);
});

it('the first message becomes the root', () => {
  const chat = createChat();
  const root = addMessage(chat, { role: 'assistant', content: 'Greetings.', parentId: null });
  assert.equal(chat.rootId, root.id);
  assert.deepEqual(contents(chat), ['Greetings.']);
});

it('messages without a parent attach to the current leaf, in order', () => {
  const chat = seeded();
  assert.deepEqual(roles(chat), ['assistant', 'user', 'assistant']);
  assert.deepEqual(contents(chat), ['Hello there.', 'Hi.', 'How are you?']);
});

it('a chat can only have one root', () => {
  const chat = createChat();
  addMessage(chat, { role: 'assistant', content: 'a', parentId: null });
  assert.throws(() => addMessage(chat, { role: 'assistant', content: 'b', parentId: null }), /already has a root/);
});

it('attaching to a missing parent throws', () => {
  const chat = createChat();
  assert.throws(() => addMessage(chat, { role: 'user', content: 'x', parentId: 'nope' }), /no such parent/);
});

/* ── Regenerate / swipe ───────────────────────────────────────────────────── */

it('regenerating an assistant reply adds an alternative and makes it active', () => {
  const chat = seeded();
  const last = leafId(chat);
  const fresh = regenerate(chat, last);
  editInPlace(chat, fresh.id, "I'm well, thanks.");

  assert.deepEqual(contents(chat), ['Hello there.', 'Hi.', "I'm well, thanks."]);
  assert.deepEqual(siblingInfo(chat, fresh.id), { index: 2, count: 2 }, 'two versions, showing the second');
});

it('you can swipe back and forth between alternatives', () => {
  const chat = seeded();
  const first = leafId(chat);
  const second = regenerate(chat, first);
  editInPlace(chat, second.id, 'Second version.');

  assert.equal(contents(chat).at(-1), 'Second version.');
  cycleSibling(chat, second.id, -1);
  assert.equal(contents(chat).at(-1), 'How are you?', 'swiped back to the first');
  cycleSibling(chat, first, +1);
  assert.equal(contents(chat).at(-1), 'Second version.', 'swiped forward again');
});

it('each alternative keeps its own continuation', () => {
  const chat = seeded();
  const a = leafId(chat); // "How are you?"
  addMessage(chat, { role: 'user', content: 'Good, you?' }); // continues version A

  const b = regenerate(chat, a); // version B of the assistant reply
  editInPlace(chat, b.id, 'Alt reply.');
  addMessage(chat, { role: 'user', content: 'Different follow-up' }); // continues version B

  assert.deepEqual(contents(chat).slice(-2), ['Alt reply.', 'Different follow-up']);
  cycleSibling(chat, b.id, -1); // back to version A
  assert.deepEqual(contents(chat).slice(-2), ['How are you?', 'Good, you?'], 'A’s own follow-up returns');
});

it('the opening message has nothing to regenerate into', () => {
  const chat = seeded();
  assert.throws(() => regenerate(chat, chat.rootId), /opening message/);
});

/* ── Editing ──────────────────────────────────────────────────────────────── */

it('editing in place keeps the subtree intact', () => {
  const chat = seeded();
  addMessage(chat, { role: 'user', content: 'downstream' });
  const userId = activePath(chat).find((n) => n.content === 'Hi.').id;
  editInPlace(chat, userId, 'Hello!');
  assert.deepEqual(contents(chat), ['Hello there.', 'Hello!', 'How are you?', 'downstream']);
});

it('editing as a branch forks the timeline and keeps the original', () => {
  const chat = seeded();
  const userNode = activePath(chat).find((n) => n.content === 'Hi.');
  const edited = editBranch(chat, userNode.id, 'Actually, hey.');

  // The active path now runs through the edited message, which has no reply yet.
  assert.deepEqual(contents(chat), ['Hello there.', 'Actually, hey.']);
  assert.deepEqual(siblingInfo(chat, edited.id), { index: 2, count: 2 });

  // The original is still there to swipe back to, with its reply.
  cycleSibling(chat, edited.id, -1);
  assert.deepEqual(contents(chat), ['Hello there.', 'Hi.', 'How are you?']);
});

it('editing the root branches into an in-place edit (roots cannot fork)', () => {
  const chat = seeded();
  const node = editBranch(chat, chat.rootId, 'New greeting.');
  assert.equal(node.id, chat.rootId);
  assert.equal(contents(chat)[0], 'New greeting.');
});

/* ── Deleting ─────────────────────────────────────────────────────────────── */

it('deleting a node removes it and everything after it', () => {
  const chat = seeded();
  const userId = activePath(chat).find((n) => n.content === 'Hi.').id;
  deleteNode(chat, userId);
  assert.deepEqual(contents(chat), ['Hello there.'], 'the reply that depended on it is gone too');
  assert.equal(Object.keys(chat.nodes).length, 1);
});

it('deleting the active alternative falls back to a sibling', () => {
  const chat = seeded();
  const first = leafId(chat);
  const second = regenerate(chat, first);
  editInPlace(chat, second.id, 'Second.');
  assert.equal(contents(chat).at(-1), 'Second.');

  deleteNode(chat, second.id);
  assert.equal(contents(chat).at(-1), 'How are you?', 'fell back to the remaining version');
  assert.deepEqual(siblingInfo(chat, first.id), { index: 1, count: 1 });
});

it('deleting the root empties the chat', () => {
  const chat = seeded();
  deleteNode(chat, chat.rootId);
  assert.equal(chat.rootId, null);
  assert.deepEqual(activePath(chat), []);
  assert.equal(Object.keys(chat.nodes).length, 0);
});

/* ── Branching to a new chat ──────────────────────────────────────────────── */

it('pathTo returns the straight line from root to a node', () => {
  const chat = seeded();
  const leaf = leafId(chat);
  assert.deepEqual(pathTo(chat, leaf).map((n) => n.content), ['Hello there.', 'Hi.', 'How are you?']);
});

it('branching copies the history into a fresh, independent chat', () => {
  const chat = seeded();
  addMessage(chat, { role: 'user', content: 'later message' });
  const branchPoint = activePath(chat).find((n) => n.content === 'How are you?');

  const fork = branchChat(chat, branchPoint.id, { title: 'Fork' });
  assert.notEqual(fork.id, chat.id);
  assert.equal(fork.title, 'Fork');
  assert.deepEqual(contents(fork), ['Hello there.', 'Hi.', 'How are you?'], 'copied up to the branch point only');
  assert.equal(fork.characterId, chat.characterId);

  // Editing the fork must not touch the original.
  editInPlace(fork, fork.rootId, 'CHANGED');
  assert.equal(activePath(chat)[0].content, 'Hello there.', 'the source chat is untouched');

  // The fork is a real editable chat.
  addMessage(fork, { role: 'assistant', content: 'a new direction' });
  assert.equal(contents(fork).at(-1), 'a new direction');
});

/* ── Done ─────────────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
