/**
 * The conversation is a tree.
 *
 * Every message is a node. A node's children are the different continuations that
 * have been tried from that point: regenerating an assistant reply adds a sibling,
 * editing-and-rerunning a message adds a sibling, and each sibling keeps its own
 * subtree. Exactly one child of each node is "active", so following the active
 * child from the root gives the single conversation you currently see. Everything
 * else — edit, regenerate, branch, swipe between alternatives, delete — is an
 * operation on this tree, and all of it lives here as pure functions so it can be
 * tested without a browser.
 *
 * A node:  { id, role, content, model, parentId, children:[id], activeChild:id|null, ts }
 * A chat:  { id, title, characterId, personaId, nodes:{id:node}, rootId, createdAt, updatedAt }
 *
 * The root is the character's opening message (single — greeting variants are
 * chosen when the chat is created, not swiped mid-chat). Every other node has a
 * parent, so regenerate/branch always have something to attach to.
 */

export function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createChat({ title, characterId = null, personaId = null } = {}) {
  const now = Date.now();
  return {
    id: makeId(),
    title: title || 'New chat',
    characterId,
    personaId,
    nodes: {},
    rootId: null,
    createdAt: now,
    updatedAt: now,
  };
}

const touch = (chat) => {
  chat.updatedAt = Date.now();
};

/** The single conversation you see: root, then active child, then its active child… */
export function activePath(chat) {
  const path = [];
  let cur = chat.rootId ? chat.nodes[chat.rootId] : null;
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    path.push(cur);
    cur = cur.activeChild ? chat.nodes[cur.activeChild] : null;
  }
  return path;
}

/** The tip of the active path — where the next message attaches. */
export function leafId(chat) {
  const path = activePath(chat);
  return path.length ? path[path.length - 1].id : null;
}

/**
 * Add a message. With no parentId it attaches to the current leaf (the normal
 * case). parentId=null makes it the root, which is only allowed once.
 */
export function addMessage(chat, { role, content = '', model = null, parentId } = {}) {
  if (parentId === undefined) parentId = leafId(chat);

  if (parentId === null) {
    if (chat.rootId) throw new Error('this chat already has a root message');
  } else if (!chat.nodes[parentId]) {
    throw new Error(`no such parent: ${parentId}`);
  }

  const node = {
    id: makeId(),
    role,
    content,
    model,
    parentId: parentId ?? null,
    children: [],
    activeChild: null,
    ts: Date.now(),
  };
  chat.nodes[node.id] = node;

  if (parentId === null) {
    chat.rootId = node.id;
  } else {
    const parent = chat.nodes[parentId];
    parent.children.push(node.id);
    parent.activeChild = node.id;
  }
  touch(chat);
  return node;
}

/**
 * Regenerate: add a fresh empty sibling next to an existing node and make it
 * active. The old version is kept as an alternative you can swipe back to. The
 * caller then streams content into the returned node.
 */
export function regenerate(chat, nodeId) {
  const node = chat.nodes[nodeId];
  if (!node) throw new Error(`no such node: ${nodeId}`);
  if (node.parentId == null) throw new Error('the opening message has no alternatives to regenerate into');
  return addMessage(chat, { role: node.role, parentId: node.parentId, model: node.model });
}

/** Change a message where it stands, keeping its place and its subtree. */
export function editInPlace(chat, nodeId, content) {
  const node = chat.nodes[nodeId];
  if (!node) throw new Error(`no such node: ${nodeId}`);
  node.content = content;
  touch(chat);
  return node;
}

/**
 * Edit as a new branch: add an edited sibling next to the node and make it active,
 * leaving the original untouched on its own branch. Used for "edit this message
 * and continue from here" — the returned node is the new active tip, ready to be
 * followed by a regenerated reply. Editing the root can't branch, so it edits in
 * place instead.
 */
export function editBranch(chat, nodeId, content) {
  const node = chat.nodes[nodeId];
  if (!node) throw new Error(`no such node: ${nodeId}`);
  if (node.parentId == null) return editInPlace(chat, nodeId, content);
  return addMessage(chat, { role: node.role, content, parentId: node.parentId, model: node.model });
}

const siblingsOf = (chat, node) =>
  node.parentId == null ? [chat.rootId].filter(Boolean) : chat.nodes[node.parentId].children;

/** Which alternative you're on, and how many there are: {index, count}, 1-based. */
export function siblingInfo(chat, nodeId) {
  const node = chat.nodes[nodeId];
  if (!node) return { index: 1, count: 1 };
  const sibs = siblingsOf(chat, node);
  const i = sibs.indexOf(nodeId);
  return { index: i < 0 ? 1 : i + 1, count: sibs.length || 1 };
}

/** Swipe to the previous/next alternative of a node; returns the now-active id. */
export function cycleSibling(chat, nodeId, dir = 1) {
  const node = chat.nodes[nodeId];
  if (!node || node.parentId == null) return nodeId;
  const parent = chat.nodes[node.parentId];
  const sibs = parent.children;
  if (sibs.length < 2) return nodeId;
  const i = sibs.indexOf(nodeId);
  const next = sibs[(i + dir + sibs.length) % sibs.length];
  parent.activeChild = next;
  touch(chat);
  return next;
}

/** Every id at or below a node, itself included. */
function subtreeIds(chat, nodeId, acc = []) {
  const node = chat.nodes[nodeId];
  if (!node) return acc;
  acc.push(nodeId);
  for (const childId of node.children) subtreeIds(chat, childId, acc);
  return acc;
}

/**
 * Delete a node and everything beneath it. The parent's active child falls back to
 * a remaining sibling, so the visible conversation stays valid. Deleting the root
 * empties the chat.
 */
export function deleteNode(chat, nodeId) {
  const node = chat.nodes[nodeId];
  if (!node) return;

  for (const id of subtreeIds(chat, nodeId)) delete chat.nodes[id];

  if (node.parentId == null) {
    chat.rootId = null;
  } else {
    const parent = chat.nodes[node.parentId];
    const at = parent.children.indexOf(nodeId);
    if (at >= 0) parent.children.splice(at, 1);
    if (parent.activeChild === nodeId) {
      parent.activeChild = parent.children[parent.children.length - 1] ?? null;
    }
  }
  touch(chat);
}

/** The straight line of nodes from the root down to a given node. */
export function pathTo(chat, nodeId) {
  const line = [];
  let cur = chat.nodes[nodeId];
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    line.push(cur);
    cur = cur.parentId ? chat.nodes[cur.parentId] : null;
  }
  return line.reverse();
}

/**
 * Fork a brand-new chat off a point in this one. The new chat gets a clean linear
 * copy of everything from the root down to the chosen node, and nothing else, so
 * you can strike out in a new direction while the original is left exactly as it
 * was. Returns the new chat; the source chat is not modified.
 */
export function branchChat(chat, nodeId, { title } = {}) {
  const line = pathTo(chat, nodeId);
  const fork = createChat({
    title: title || `${chat.title} (branch)`,
    characterId: chat.characterId,
    personaId: chat.personaId,
  });

  let parentId; // undefined → root for the first node
  for (const src of line) {
    const copy = addMessage(fork, {
      role: src.role,
      content: src.content,
      model: src.model,
      parentId: line.indexOf(src) === 0 ? null : parentId,
    });
    parentId = copy.id;
  }
  return fork;
}

/** Roles as the API wants them: everything that isn't the assistant is "user". */
export function apiRole(role) {
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}
