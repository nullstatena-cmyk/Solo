/**
 * The interface.
 *
 * Holds all browser-side state and wires it to the DOM. Everything is a world:
 * a world owns a cast (all of whom the AI plays), a lorebook (the world bible),
 * and a fact-store memory whose knowledge is gated by who was present. Scenes are
 * chats inside a world with a present-cast roster. The tricky logic — the message
 * tree, presence-gated facts, lore triggering, extraction/summarization — lives in
 * the tested modules; this file drives them and renders the result.
 */

import * as tree from './tree.js';
import * as prompt from './prompt.js';
import * as api from './api.js';
import * as storage from './storage.js';
import * as W from './world.js';
import * as memory from './memory.js';
import { normalizeCard, extractCardFromPng } from './card.js';

/* ── Defaults & seeds ─────────────────────────────────────────────────────── */

const DEFAULT_SETTINGS = {
  endpoint: '',
  apiKey: '',
  model: 'venice/uncensored',
  utilityModel: '', // for memory/summaries; blank → same as model
  temperature: 0.9,
  maxTokens: 512,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  stream: true,
  contextTokens: 8000,
  systemPrefix: '',
  autoMemory: true,
  autoSummary: true,
  summaryThreshold: 2400,
  summaryKeepRecent: 6,
};

const SUGGESTED_MODELS = [
  'venice/uncensored',
  'thedrummer/cydonia-24b-v4.1',
  'sao10k/l3.3-euryale-70b',
  'neversleep/llama-3-lumimaid-70b',
  'nousresearch/hermes-3-llama-3.1-70b',
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o',
];

function starterWorld() {
  const w = W.createWorld({
    name: 'The Hollow Coast',
    mode: 'new',
    description:
      'A fog-bound stretch of fishing villages and drowned ruins where old bargains with the sea still hold power.',
  });
  W.addCharacter(w, W.createCharacter({
    name: 'Mara', avatar: '🌊',
    description: 'The harbormaster of Saltcombe — weathered, dry-humored, and keeper of the town’s quieter secrets.',
    personality: 'shrewd, protective, slow to trust, fiercely loyal once earned',
    greeting: '*Mara doesn’t look up from the rope she’s splicing until your boots hit the end of the dock.* "Tide’s wrong for strangers. But you’re here now." *She finally meets your eyes, weighing you like a catch.* "Say your business, {{user}}, and mind you say it true."',
  }));
  W.addCharacter(w, W.createCharacter({
    name: 'Finn', avatar: '🔥',
    description: 'A restless young lamplighter chasing the ghost stories his elders won’t tell.',
    personality: 'eager, warm, reckless, endlessly curious',
  }));
  W.addLoreEntry(w, { name: 'Saltcombe', keys: 'saltcombe, the town, village, harbor, dock', content: 'Saltcombe is a fog-bound fishing town built over older, drowned ruins. Its people leave small tithes to the sea each new moon.' });
  W.addLoreEntry(w, { name: 'The Drowned Bell', keys: 'bell, drowned bell, ruins', content: 'A great bronze bell lies in the ruins beneath the harbor. When it tolls on its own, someone in Saltcombe is about to break a bargain.' });
  W.addLoreEntry(w, { always: true, content: 'Tone: atmospheric folk-horror-tinged adventure — eerie, humane, and grounded.' });
  return w;
}

const starterPersona = () => ({ id: tree.makeId(), name: 'You', avatar: '🧑', description: '' });

/* ── State ────────────────────────────────────────────────────────────────── */

const state = {
  worldMetas: [], // [{ id, name, mode, updatedAt }]
  activeWorld: null, // full world
  personas: [],
  settings: { ...DEFAULT_SETTINGS },
  chatMetas: [], // [{ id, title, worldId, updatedAt }]
  activeChat: null,
  activeChatId: null,
  activePersonaId: null,
  editingId: null,
  streamingId: null,
  generating: false,
  memoryBusy: false,
  abortController: null,
};

const el = {};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const currentPersona = () => state.personas.find((p) => p.id === state.activePersonaId) || null;
const castById = (id) => (state.activeWorld ? W.characterById(state.activeWorld, id) : null);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

function formatContent(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\r?\n/g, '<br>');
  return html;
}

function avatarMarkup(avatar, fallback) {
  if (avatar && /^(https?:|data:)/.test(avatar)) return `<img src="${escapeAttr(avatar)}" alt="" />`;
  return escapeHtml(avatar || fallback);
}

function toast(message, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`.trim();
  t.textContent = message;
  el.toasts.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, kind === 'err' ? 4200 : 2400);
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile({ accept = '', as = 'text' } = {}) {
  return new Promise((resolve) => {
    el.fileInput.value = '';
    el.fileInput.accept = accept;
    el.fileInput.onchange = () => {
      const f = el.fileInput.files[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, type: f.type, data: r.result });
      r.onerror = () => { toast('Could not read that file.', 'err'); resolve(null); };
      if (as === 'arraybuffer') r.readAsArrayBuffer(f); else r.readAsText(f);
    };
    el.fileInput.click();
  });
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function cssEscape(s) {
  if (globalThis.CSS?.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

const presentCharacters = (chat) =>
  !chat || !state.activeWorld ? [] : (chat.presentCast || []).map((id) => castById(id)).filter(Boolean);

function presentLabel(chat) {
  const present = presentCharacters(chat);
  if (present.length === 1) return present[0].name;
  return state.activeWorld?.name || 'The scene';
}

/* ── Persistence ──────────────────────────────────────────────────────────── */

function hydrate() {
  const index = storage.loadIndex();
  if (!index) {
    const w = starterWorld();
    const persona = starterPersona();
    storage.saveWorld(w);
    state.worldMetas = [worldMeta(w)];
    state.activeWorld = w;
    state.personas = [persona];
    state.activePersonaId = persona.id;
    state.settings = { ...DEFAULT_SETTINGS };
    state.chatMetas = [];
    state.activeChatId = null;
    persistIndex();
    return;
  }
  state.worldMetas = index.worldMetas || [];
  state.personas = index.personas || [];
  state.settings = { ...DEFAULT_SETTINGS, ...(index.settings || {}) };
  state.chatMetas = index.chatMetas || [];
  state.activePersonaId = index.activePersonaId || state.personas[0]?.id || null;
  const activeWorldId = index.activeWorldId || state.worldMetas[0]?.id || null;
  state.activeWorld = activeWorldId ? storage.loadWorld(activeWorldId) : null;
  state.activeChatId = index.activeChatId || null;
  if (state.activeChatId) {
    state.activeChat = storage.loadChat(state.activeChatId);
    if (!state.activeChat) state.activeChatId = null;
    else if (state.activeChat.worldId && state.activeChat.worldId !== state.activeWorld?.id) {
      const w = storage.loadWorld(state.activeChat.worldId);
      if (w) state.activeWorld = w;
    }
  }
}

const worldMeta = (w) => ({ id: w.id, name: w.name, mode: w.mode, updatedAt: w.updatedAt });

function persistIndex() {
  storage.saveIndex({
    personas: state.personas,
    settings: state.settings,
    worldMetas: state.worldMetas,
    chatMetas: state.chatMetas,
    activeWorldId: state.activeWorld?.id || null,
    activePersonaId: state.activePersonaId,
    activeChatId: state.activeChatId,
  });
}

function persistWorld() {
  const w = state.activeWorld;
  if (!w) return;
  storage.saveWorld(w);
  const i = state.worldMetas.findIndex((m) => m.id === w.id);
  if (i >= 0) state.worldMetas[i] = worldMeta(w); else state.worldMetas.push(worldMeta(w));
  persistIndex();
}

function upsertChatMeta(chat) {
  const meta = { id: chat.id, title: chat.title, worldId: chat.worldId, updatedAt: chat.updatedAt };
  const i = state.chatMetas.findIndex((m) => m.id === chat.id);
  if (i >= 0) state.chatMetas[i] = meta; else state.chatMetas.push(meta);
}

function persistChat(chat) {
  if (!chat) return;
  storage.saveChat(chat);
  upsertChatMeta(chat);
  persistIndex();
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderMessages();
  renderUsage();
  updateComposer();
}

function renderSidebar() {
  const w = state.activeWorld;
  el.worldSwitchName.textContent = w?.name || 'No world';
  el.worldSwitchMode.textContent = w ? (w.mode === 'jumpin' ? 'Jump In' : 'New World') : '';
  el.worldSwitchIcon.textContent = w?.mode === 'jumpin' ? '🎬' : '🌍';

  const metas = state.chatMetas
    .filter((m) => m.worldId === state.activeWorld?.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (!w) {
    el.chatList.innerHTML = '<div class="chat-list-empty">Create a world to begin.</div>';
    return;
  }
  if (metas.length === 0) {
    el.chatList.innerHTML = '<div class="chat-list-empty">No scenes yet.<br />Start one with “＋ New scene”.</div>';
    return;
  }
  el.chatList.innerHTML = metas
    .map((m) => `
      <div class="chat-item ${m.id === state.activeChatId ? 'active' : ''}" data-chat="${escapeAttr(m.id)}">
        <span class="chat-item-title">${escapeHtml(m.title || 'Untitled')}</span>
        <button class="chat-item-del" data-del-chat="${escapeAttr(m.id)}" title="Delete scene" aria-label="Delete scene">×</button>
      </div>`)
    .join('');
}

function renderHeader() {
  const chat = state.activeChat;
  const persona = currentPersona();
  el.chatTitle.value = chat?.title || '';
  el.chatTitle.disabled = !chat;
  el.headerPersona.textContent = persona?.name ? `as ${persona.name}` : '';
  el.headerModel.textContent = state.settings.model || 'no model set';
  el.btnDeleteChat.classList.toggle('hidden', !chat);
  el.btnBranchMenu.classList.toggle('hidden', !chat || tree.activePath(chat).length === 0);
  renderPresentCast();
}

function renderPresentCast() {
  const chat = state.activeChat;
  if (!chat || !state.activeWorld) { el.presentCast.innerHTML = ''; return; }
  const chips = presentCharacters(chat)
    .map((c) => `<span class="cast-chip">${escapeHtml(c.name)}<button data-leave="${escapeAttr(c.id)}" title="Leave scene" aria-label="Remove ${escapeAttr(c.name)}">×</button></span>`)
    .join('');
  const canAdd = state.activeWorld.cast.some((c) => !(chat.presentCast || []).includes(c.id));
  const add = canAdd ? '<span class="cast-chip add" data-add-cast title="Add a character to the scene">＋ cast</span>' : '';
  el.presentCast.innerHTML = chips + add;
}

function renderMessages() {
  const chat = state.activeChat;
  if (!chat) { el.messages.innerHTML = emptyNoChat(); return; }
  const path = tree.activePath(chat);
  if (path.length === 0) { el.messages.innerHTML = emptyChat(); return; }
  el.messages.innerHTML = path.map((node) => renderMessage(node, chat)).join('');
  if (state.editingId) {
    const ta = el.messages.querySelector(`.msg[data-id="${cssEscape(state.editingId)}"] .msg-edit textarea`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function renderMessage(node, chat) {
  const world = state.activeWorld;
  const persona = currentPersona();
  const isAsst = node.role === 'assistant';
  let name;
  let avatar;
  if (isAsst) {
    name = node.name || presentLabel(chat);
    const match = world?.cast.find((c) => c.name === name);
    avatar = avatarMarkup(match?.avatar, '🎭');
  } else {
    name = persona?.name || 'You';
    avatar = avatarMarkup(persona?.avatar, '🧑');
  }
  const names = { charName: presentLabel(chat), userName: persona?.name };
  const sib = tree.siblingInfo(chat, node.id);
  const streaming = state.streamingId === node.id;

  let body;
  if (state.editingId === node.id) {
    body = `
      <div class="msg-edit">
        <textarea spellcheck="false">${escapeHtml(node.content)}</textarea>
        <div class="msg-edit-actions">
          <button class="btn primary" data-action="edit-save">Save</button>
          ${!isAsst ? '<button class="btn" data-action="edit-rerun">Save &amp; rerun</button>' : ''}
          <button class="btn ghost" data-action="edit-cancel">Cancel</button>
        </div>
      </div>`;
  } else {
    body = `<div class="msg-content">${formatContent(prompt.fillPlaceholders(node.content, names))}</div>`;
  }

  const swipe = sib.count > 1
    ? `<span class="swipe">
         <button data-action="swipe-prev" title="Previous version">‹</button>
         <span class="swipe-count">${sib.index}/${sib.count}</span>
         <button data-action="swipe-next" title="Next version">›</button>
       </span>`
    : '';

  const actions = state.editingId === node.id ? '' : `
    <div class="msg-actions">
      ${swipe}
      <button class="act-btn" data-action="copy" title="Copy">⧉ Copy</button>
      <button class="act-btn" data-action="edit" title="Edit">✎ Edit</button>
      ${isAsst && node.parentId != null ? '<button class="act-btn" data-action="regenerate" title="Regenerate">↻ Retry</button>' : ''}
      <button class="act-btn" data-action="branch" title="Fork a new scene from here">⑃ Branch</button>
      <button class="act-btn danger" data-action="delete" title="Delete">🗑</button>
    </div>`;

  return `
    <div class="msg ${isAsst ? 'assistant' : 'user'} ${streaming ? 'streaming' : ''}" data-id="${escapeAttr(node.id)}">
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-main">
        <div class="msg-head">
          <span class="msg-name">${escapeHtml(name)}</span>
          ${isAsst && node.model ? `<span class="msg-model">${escapeHtml(node.model)}</span>` : ''}
        </div>
        ${body}
        ${actions}
      </div>
    </div>`;
}

function emptyNoChat() {
  const w = state.activeWorld;
  if (!w) {
    return `<div class="empty-chat"><h2>Welcome to Solo RP</h2>
      <p>Create a world — its cast, its lore, its memory — then start a scene. Add your OpenRouter key in <strong>Settings</strong> to bring it to life.</p></div>`;
  }
  return `<div class="empty-chat"><h2>${escapeHtml(w.name)}</h2>
    <p>No scene open. Hit <strong>＋ New scene</strong> to begin.</p></div>`;
}

function emptyChat() {
  return `<div class="empty-chat"><h2>Empty scene</h2>
    <p>Type below to begin, or press <strong>✦ Set the scene</strong> to have the cast open it.</p></div>`;
}

function renderUsage() {
  let bytes = 0;
  try { bytes = storage.usageBytes(); } catch { bytes = 0; }
  const kb = bytes / 1024;
  const size = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  const chat = state.activeChat;
  const turns = chat ? tree.activePath(chat).length : 0;
  const w = state.activeWorld;
  const facts = w ? w.facts.length : 0;
  const mem = state.memoryBusy ? ' · updating memory…' : '';
  el.usageNote.textContent = `${turns} msg${turns === 1 ? '' : 's'} · ${facts} memor${facts === 1 ? 'y' : 'ies'} · ${size}${mem}`;
}

/* ── Generation ───────────────────────────────────────────────────────────── */

function recentTextFor(chat) {
  const path = tree.activePath(chat).slice(-6).map((n) => n.content);
  const persona = currentPersona();
  return [persona?.description || '', ...path].join('\n');
}

function buildMessages() {
  const world = state.activeWorld;
  const chat = state.activeChat;
  const persona = currentPersona();
  const lore = W.selectLore(world, recentTextFor(chat));
  const gated = W.factsKnownInScene(world, chat.presentCast || []).map((f) => ({ ...f, knownByNames: W.knownByNames(world, f) }));
  return prompt.buildWorldMessages({ chat, world, persona, settings: state.settings, lore, facts: gated, summary: chat.summary || '' });
}

function setGenerating(on) {
  state.generating = on;
  el.btnSend.disabled = on;
  el.btnStop.classList.toggle('hidden', !on);
  el.btnSend.classList.toggle('hidden', on);
  for (const b of [el.btnRegenerate, el.btnContinue, el.btnImpersonate, el.btnOpening]) b.disabled = on;
  el.genStatus.classList.toggle('hidden', !on);
  if (on) el.genStatus.textContent = `${presentLabel(state.activeChat)} is writing…`;
}

function setMemoryBusy(on) {
  state.memoryBusy = on;
  renderUsage();
}

const contentElOf = (id) => el.messages.querySelector(`.msg[data-id="${cssEscape(id)}"] .msg-content`);

async function runGeneration(messages, onDelta, { settings = state.settings } = {}) {
  setGenerating(true);
  const controller = new AbortController();
  state.abortController = controller;
  let full = '';
  try {
    for await (const chunk of api.streamChat({ messages, settings, signal: controller.signal })) {
      full += chunk;
      onDelta?.(full);
    }
    return { full, aborted: false };
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) return { full, aborted: true };
    toast(err.message || 'Generation failed.', 'err');
    return { full, error: err };
  } finally {
    setGenerating(false);
    state.abortController = null;
  }
}

async function streamInto(node, { nudge = null, append = false, removeOnError = false, afterTurn = false } = {}) {
  const chat = state.activeChat;
  const messages = buildMessages();
  if (nudge) messages.push({ role: 'user', content: nudge });

  const base = append ? node.content : '';
  state.streamingId = node.id;
  renderMessages();
  scrollToBottom();

  const { full, error, aborted } = await runGeneration(messages, (sofar) => {
    node.content = base + sofar;
    const e = contentElOf(node.id);
    if (e) e.textContent = node.content;
    scrollToBottomIfNear();
  });

  state.streamingId = null;

  if (error) {
    if (removeOnError && !append) tree.deleteNode(chat, node.id);
    else if (!append) node.content = base;
  } else if (!append && !aborted && !full.trim()) {
    tree.deleteNode(chat, node.id);
    toast('The model returned no text — check your model ID and key in Settings.', 'err');
  }

  renderMessages();
  renderUsage();
  persistChat(chat);

  if (afterTurn && !error && !aborted && full.trim()) await runAfterTurn();
}

async function send() {
  if (state.generating) return;
  const text = el.input.value.trim();
  if (!text) return;

  const cmd = memory.parseCommand(text);
  if (cmd) { el.input.value = ''; autoGrow(); return handleCommand(cmd); }

  if (!state.activeWorld) { toast('Create a world first.'); return openWorlds(); }
  if (!state.activeWorld.cast.length) { toast('Add a character to the cast first.'); return openCast(); }
  if (!state.settings.apiKey) { toast('Add your OpenRouter API key in Settings.', 'err'); return openSettings(); }
  if (!state.activeChat) createSceneInWorld();

  el.input.value = '';
  autoGrow();
  tree.addMessage(state.activeChat, { role: 'user', content: text });
  renderMessages();
  scrollToBottom();
  await generateReply();
}

function labelAssistant(node) {
  node.name = presentLabel(state.activeChat);
  return node;
}

async function generateReply() {
  const chat = state.activeChat;
  const asst = labelAssistant(tree.addMessage(chat, { role: 'assistant', content: '', model: state.settings.model }));
  await streamInto(asst, { removeOnError: true, afterTurn: true });
}

async function openingLine() {
  if (state.generating) return;
  if (!state.activeWorld?.cast.length) { toast('Add a character to the cast first.'); return openCast(); }
  if (!state.settings.apiKey) { toast('Add your OpenRouter API key in Settings.', 'err'); return openSettings(); }
  if (!state.activeChat) createSceneInWorld();
  const chat = state.activeChat;
  const asst = labelAssistant(tree.addMessage(chat, { role: 'assistant', content: '', model: state.settings.model }));
  await streamInto(asst, { removeOnError: true, nudge: '(Open the scene: set the mood and have the present characters react to the newcomer. A few vivid sentences.)' });
}

async function regenerateNode(id) {
  if (state.generating) return;
  const chat = state.activeChat;
  const node = chat.nodes[id];
  if (!node || node.role !== 'assistant' || node.parentId == null) return;
  const fresh = labelAssistant(tree.regenerate(chat, id));
  await streamInto(fresh, { removeOnError: true });
}

async function regenerateLast() {
  const id = tree.leafId(state.activeChat);
  const node = id ? state.activeChat.nodes[id] : null;
  if (!node) return;
  if (node.role !== 'assistant') return toast('The last message is yours — send it, then regenerate the reply.');
  await regenerateNode(id);
}

async function continueLast() {
  if (state.generating) return;
  const chat = state.activeChat;
  const id = tree.leafId(chat);
  const node = id ? chat.nodes[id] : null;
  if (!node || node.role !== 'assistant') return toast('There is no reply to continue.');
  await streamInto(node, { append: true, nudge: '(OOC: continue your previous message from exactly where it stopped. Do not repeat any earlier text.)' });
}

async function impersonate() {
  if (state.generating || !state.activeChat) return;
  const persona = currentPersona();
  const messages = buildMessages();
  messages.push({ role: 'user', content: `(OOC: Write the next message as ${persona?.name || 'the user'}, in first person, a single in-character message. Do not write for the other characters.)` });
  el.input.value = '';
  const { full } = await runGeneration(messages, (sofar) => { el.input.value = sofar; autoGrow(); });
  el.input.value = full.trim();
  autoGrow();
  el.input.focus();
}

function stopGenerating() {
  if (state.abortController) state.abortController.abort();
}

/* ── Memory jobs (LLM) ────────────────────────────────────────────────────── */

async function utilityComplete(messages, { maxTokens = 512 } = {}) {
  const settings = { ...state.settings, model: state.settings.utilityModel || state.settings.model, stream: false, temperature: 0.2, maxTokens };
  let out = '';
  for await (const chunk of api.streamChat({ messages, settings })) out += chunk;
  return out;
}

async function runAfterTurn() {
  if (state.settings.autoMemory) await runExtraction(true);
  if (state.settings.autoSummary && memory.shouldSummarize(state.activeChat, state.settings)) await runSummary(true);
}

async function runExtraction(quiet = false) {
  const world = state.activeWorld;
  const chat = state.activeChat;
  if (!world || !chat || !state.settings.apiKey) { if (!quiet) toast('Set a model and key first.', 'err'); return; }
  const path = tree.activePath(chat);
  const lastAsst = [...path].reverse().find((n) => n.role === 'assistant');
  const lastUser = [...path].reverse().find((n) => n.role === 'user');
  if (!lastAsst) return;
  const persona = currentPersona();
  const exchange = [lastUser, lastAsst].filter(Boolean)
    .map((n) => `${n.role === 'assistant' ? 'Scene' : persona?.name || 'User'}: ${n.content}`)
    .join('\n');
  const castNames = presentCharacters(chat).map((c) => c.name);
  const knownText = W.factsKnownInScene(world, chat.presentCast || []).slice(-40).map((f) => `- ${f.text}`).join('\n');
  const messages = memory.buildExtractionMessages({ exchangeText: exchange, castNames, knownFactsText: knownText });

  setMemoryBusy(true);
  try {
    const text = await utilityComplete(messages, { maxTokens: 400 });
    const facts = memory.parseFactList(text);
    const fresh = memory.dedupeFacts(world.facts.map((f) => f.text), facts);
    for (const t of fresh) W.addFact(world, { text: t, knownBy: chat.presentCast || [], sceneId: chat.id });
    if (fresh.length) { persistWorld(); if (!quiet) toast(`Filed ${fresh.length} new memor${fresh.length === 1 ? 'y' : 'ies'}.`, 'ok'); }
    else if (!quiet) toast('No new facts to remember.');
    return fresh.length;
  } catch (err) {
    if (!quiet) toast('Memory extraction failed.', 'err');
  } finally {
    setMemoryBusy(false);
  }
}

async function runSummary(quiet = false) {
  const chat = state.activeChat;
  const world = state.activeWorld;
  if (!chat || !state.settings.apiKey) { if (!quiet) toast('Set a model and key first.', 'err'); return; }
  const { fold, ids } = memory.nodesToSummarize(chat, state.settings);
  const foldNodes = fold.length ? fold : tree.activePath(chat).filter((n) => n.parentId != null);
  if (!foldNodes.length) { if (!quiet) toast('Nothing to summarize yet.'); return; }
  const persona = currentPersona();
  const charName = presentCharacters(chat).map((c) => c.name).join(' & ') || world?.name || 'Scene';
  const transcript = memory.transcriptOf(foldNodes, { charName, userName: persona?.name || 'User' });
  const messages = memory.buildSummaryMessages({ priorSummary: chat.summary || '', transcript });

  setMemoryBusy(true);
  try {
    const text = await utilityComplete(messages, { maxTokens: 700 });
    if (text.trim()) {
      chat.summary = text.trim();
      if (ids.length) chat.summarizedIds = [...(chat.summarizedIds || []), ...ids];
      persistChat(chat);
      if (!quiet) toast('Story summary updated.', 'ok');
    }
    return text.trim();
  } catch (err) {
    if (!quiet) toast('Summarization failed.', 'err');
  } finally {
    setMemoryBusy(false);
  }
}

async function recapNow() {
  const chat = state.activeChat;
  if (!chat) return;
  if (!state.settings.apiKey) { toast('Add your OpenRouter API key in Settings.', 'err'); return openSettings(); }
  const persona = currentPersona();
  const nodes = tree.activePath(chat).filter((n) => n.parentId != null);
  if (!nodes.length && !chat.summary) return toast('Nothing has happened yet.');
  const charName = presentCharacters(chat).map((c) => c.name).join(' & ') || state.activeWorld?.name || 'Scene';
  const transcript = memory.transcriptOf(nodes, { charName, userName: persona?.name || 'User' });
  openInfo('Recap', '<div class="mem-busy">Writing a recap…</div>');
  try {
    const text = await utilityComplete(memory.buildSummaryMessages({ priorSummary: chat.summary || '', transcript }), { maxTokens: 700 });
    openInfo('Recap — the story so far', `<div style="white-space:pre-wrap;line-height:1.6;">${escapeHtml(text.trim() || 'Nothing to recap.')}</div>`);
  } catch (err) {
    openInfo('Recap', `<p class="mem-empty">${escapeHtml(err.message || 'Failed to build a recap.')}</p>`);
  }
}

/* ── Commands ─────────────────────────────────────────────────────────────── */

async function handleCommand({ cmd, arg }) {
  if (cmd === 'help') return openInfo('Commands', commandHelpHtml());
  if (!state.activeChat && cmd !== 'help') { toast('Open a scene first.'); return; }
  const world = state.activeWorld;
  const chat = state.activeChat;

  if (cmd === 'recap') return recapNow();

  if (cmd === 'whoknows') {
    const rows = W.whoKnows(world, arg);
    if (!rows.length) return openInfo('Who knows?', '<p class="mem-empty">No matching facts.</p>');
    const html = rows.map((r) => `<div class="fact-row"><div class="fact-text">${escapeHtml(r.text)}<div class="fact-who ${r.who[0] === 'everyone' ? 'everyone' : ''}">known by ${escapeHtml(r.who.join(', '))}</div></div></div>`).join('');
    return openInfo(arg ? `Who knows: “${arg}”` : 'All known facts', html);
  }

  if (cmd === 'join' || cmd === 'leave') {
    const match = world.cast.find((c) => c.name.toLowerCase().includes(arg.toLowerCase()));
    if (!match) return toast(`No cast member matches “${arg}”.`, 'err');
    const set = new Set(chat.presentCast || []);
    if (cmd === 'join') set.add(match.id); else set.delete(match.id);
    chat.presentCast = [...set];
    persistChat(chat);
    renderHeader();
    return toast(`${match.name} ${cmd === 'join' ? 'joined' : 'left'} the scene.`, 'ok');
  }

  if (cmd === 'remember' || cmd === 'correct') {
    if (!arg) return toast('Give the fact to record, e.g. /remember The bridge is out.');
    if (cmd === 'correct') W.addFact(world, { text: arg, everyone: true, sceneId: chat.id });
    else W.addFact(world, { text: arg, knownBy: chat.presentCast || [], sceneId: chat.id });
    persistWorld();
    renderUsage();
    return toast('Noted in memory.', 'ok');
  }
}

function commandHelpHtml() {
  const rows = [
    ['/recap', 'Write a “story so far” recap of this scene.'],
    ['/whoknows [text]', 'List facts (optionally matching text) and who knows them.'],
    ['/join [name]', 'Bring a cast member into the current scene.'],
    ['/leave [name]', 'Remove a cast member from the scene.'],
    ['/remember [fact]', 'File a fact, known to whoever is present.'],
    ['/correct [fact]', 'File a world truth known to everyone (fix a contradiction).'],
    ['/help', 'Show this list.'],
  ];
  return `<div style="display:flex;flex-direction:column;gap:8px;">${rows
    .map(([c, d]) => `<div><code>${escapeHtml(c)}</code><div style="color:var(--text-dim);font-size:13px;margin-top:2px;">${escapeHtml(d)}</div></div>`)
    .join('')}</div>`;
}

/* ── Message actions ──────────────────────────────────────────────────────── */

function onMessagesClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const wrap = e.target.closest('.msg[data-id]');
  const id = wrap?.dataset.id;
  if (!id) return;
  const a = btn.dataset.action;
  if (a === 'copy') return copyMessage(id);
  if (a === 'edit') return startEdit(id);
  if (a === 'delete') return confirmDeleteMessage(id);
  if (a === 'branch') return branchFrom(id);
  if (a === 'regenerate') return regenerateNode(id);
  if (a === 'swipe-prev') return swipe(id, -1);
  if (a === 'swipe-next') return swipe(id, +1);
  if (a === 'edit-save') return saveEdit(id, false);
  if (a === 'edit-rerun') return saveEdit(id, true);
  if (a === 'edit-cancel') return cancelEdit();
}

async function copyMessage(id) {
  const node = state.activeChat.nodes[id];
  if (!node) return;
  try { await navigator.clipboard.writeText(node.content); toast('Copied.', 'ok'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = node.content; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied.', 'ok'); } catch { toast('Could not copy.', 'err'); }
    ta.remove();
  }
}

function startEdit(id) { if (state.generating) return; state.editingId = id; renderMessages(); }
function cancelEdit() { state.editingId = null; renderMessages(); }

async function saveEdit(id, rerun) {
  const chat = state.activeChat;
  const ta = el.messages.querySelector(`.msg[data-id="${cssEscape(id)}"] .msg-edit textarea`);
  if (!ta) return;
  const value = ta.value;
  state.editingId = null;
  if (rerun) {
    tree.editBranch(chat, id, value);
    renderMessages();
    persistChat(chat);
    await generateReply();
  } else {
    tree.editInPlace(chat, id, value);
    renderMessages();
    persistChat(chat);
  }
}

function swipe(id, dir) { tree.cycleSibling(state.activeChat, id, dir); renderMessages(); persistChat(state.activeChat); }

function confirmDeleteMessage(id) {
  const node = state.activeChat.nodes[id];
  if (!node) return;
  const isRoot = node.parentId == null;
  openConfirm({
    title: 'Delete message',
    body: isRoot ? 'This is the opening message. Deleting it clears the scene.' : 'Delete this message and everything after it on this path?',
    danger: true, confirmLabel: 'Delete',
    onConfirm: () => { tree.deleteNode(state.activeChat, id); renderMessages(); renderUsage(); persistChat(state.activeChat); },
  });
}

function branchFrom(id) {
  const chat = state.activeChat;
  const fork = tree.branchChat(chat, id);
  fork.worldId = chat.worldId;
  fork.personaId = chat.personaId;
  fork.presentCast = [...(chat.presentCast || [])];
  fork.summary = chat.summary || '';
  fork.summarizedIds = [...(chat.summarizedIds || [])];
  state.activeChat = fork;
  state.activeChatId = fork.id;
  persistChat(fork);
  renderAll();
  toast('Branched into a new scene.', 'ok');
}

/* ── Scenes ───────────────────────────────────────────────────────────────── */

function createSceneInWorld() {
  const world = state.activeWorld;
  const chat = tree.createChat({ title: `${world.name} — ${new Date().toLocaleDateString()}`, personaId: state.activePersonaId });
  chat.worldId = world.id;
  chat.presentCast = world.cast.map((c) => c.id);
  chat.summary = '';
  chat.summarizedIds = [];
  // If exactly one cast member and they have a greeting, open with it.
  if (world.cast.length === 1 && world.cast[0].greeting?.trim()) {
    const root = tree.addMessage(chat, { role: 'assistant', content: world.cast[0].greeting, parentId: null, model: state.settings.model });
    root.name = world.cast[0].name;
  }
  state.activeChat = chat;
  state.activeChatId = chat.id;
  persistChat(chat);
  return chat;
}

function newScene() {
  if (!state.activeWorld) { toast('Create a world first.'); return openWorlds(); }
  if (!state.activeWorld.cast.length) { toast('Add a character to the cast first.'); return openCast(); }
  createSceneInWorld();
  renderAll();
  closeSidebarMobile();
}

function openScene(id) {
  if (id === state.activeChatId) return closeSidebarMobile();
  const chat = storage.loadChat(id);
  if (!chat) return toast('That scene could not be loaded.', 'err');
  state.activeChat = chat;
  state.activeChatId = id;
  state.editingId = null;
  if (chat.personaId) state.activePersonaId = chat.personaId;
  persistIndex();
  renderAll();
  closeSidebarMobile();
}

function confirmDeleteChat(id) {
  const meta = state.chatMetas.find((m) => m.id === id);
  openConfirm({
    title: 'Delete scene', body: `Delete “${meta?.title || 'this scene'}”? This can't be undone.`,
    danger: true, confirmLabel: 'Delete',
    onConfirm: () => {
      storage.removeChat(id);
      state.chatMetas = state.chatMetas.filter((m) => m.id !== id);
      if (state.activeChatId === id) {
        const next = state.chatMetas.filter((m) => m.worldId === state.activeWorld?.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (next) { state.activeChat = storage.loadChat(next.id); state.activeChatId = next.id; }
        else { state.activeChat = null; state.activeChatId = null; }
      }
      persistIndex();
      renderAll();
    },
  });
}

function renameActiveChat() {
  const chat = state.activeChat;
  if (!chat) return;
  chat.title = el.chatTitle.value.trim() || 'Untitled';
  chat.updatedAt = Date.now();
  persistChat(chat);
  renderSidebar();
}

function toggleCastPresence(id, present) {
  const chat = state.activeChat;
  if (!chat) return;
  const set = new Set(chat.presentCast || []);
  if (present) set.add(id); else set.delete(id);
  chat.presentCast = [...set];
  persistChat(chat);
  renderHeader();
}

function openAddCastPicker() {
  const chat = state.activeChat;
  const world = state.activeWorld;
  const avail = world.cast.filter((c) => !(chat.presentCast || []).includes(c.id));
  if (!avail.length) return;
  const rows = avail.map((c) => `<div class="list-row"><div class="row-avatar">${avatarMarkup(c.avatar, '🎭')}</div><div class="row-main"><div class="row-name">${escapeHtml(c.name)}</div></div><button class="mini-btn" data-add-present="${escapeAttr(c.id)}">Add to scene</button></div>`).join('');
  const modal = openModal(modalShell('Add to scene', rows, '<button class="btn ghost" data-close>Done</button>'));
  modal.querySelectorAll('[data-add-present]').forEach((b) => (b.onclick = () => { toggleCastPresence(b.dataset.addPresent, true); closeModal(); }));
}

/* ── Modals: shell ────────────────────────────────────────────────────────── */

function openModal(html) {
  el.modalRoot.innerHTML = html;
  el.modalRoot.classList.remove('hidden');
  el.modalRoot.setAttribute('aria-hidden', 'false');
  return el.modalRoot.querySelector('.modal');
}
function closeModal() {
  el.modalRoot.classList.add('hidden');
  el.modalRoot.setAttribute('aria-hidden', 'true');
  el.modalRoot.innerHTML = '';
}
function modalShell(title, bodyHtml, footHtml, { wide = false } = {}) {
  return `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="modal-close" data-close title="Close">×</button></div>
      <div class="modal-body">${bodyHtml}</div>
      ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
    </div>`;
}
function openInfo(title, bodyHtml) {
  openModal(modalShell(title, bodyHtml, '<button class="btn primary" data-close>Close</button>'));
}

/* ── Worlds ───────────────────────────────────────────────────────────────── */

function openWorlds() {
  const rows = state.worldMetas
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((m) => `
      <div class="list-row ${m.id === state.activeWorld?.id ? 'active' : ''}">
        <div class="row-avatar">${m.mode === 'jumpin' ? '🎬' : '🌍'}</div>
        <div class="row-main"><div class="row-name">${escapeHtml(m.name)}</div><div class="row-sub">${m.mode === 'jumpin' ? 'Jump In — existing setting' : 'New World — original'}</div></div>
        <div class="row-acts">
          <button class="mini-btn" data-use-world="${escapeAttr(m.id)}">Open</button>
          <button class="mini-btn" data-edit-world="${escapeAttr(m.id)}">Edit</button>
          <button class="mini-btn danger" data-del-world="${escapeAttr(m.id)}">Delete</button>
        </div>
      </div>`)
    .join('') || '<p class="modal-note">No worlds yet.</p>';
  const foot = `<button class="btn ghost" data-close>Close</button><button class="btn" data-import-world>⭱ Import</button><button class="btn primary" data-new-world>＋ New world</button>`;
  const modal = openModal(modalShell('Worlds', rows, foot, { wide: true }));
  modal.querySelectorAll('[data-use-world]').forEach((b) => (b.onclick = () => switchWorld(b.dataset.useWorld)));
  modal.querySelectorAll('[data-edit-world]').forEach((b) => (b.onclick = () => worldEditor(b.dataset.editWorld)));
  modal.querySelectorAll('[data-del-world]').forEach((b) => (b.onclick = () => confirmDeleteWorld(b.dataset.delWorld)));
  modal.querySelector('[data-new-world]').onclick = () => worldEditor(null);
  modal.querySelector('[data-import-world]').onclick = importWorld;
}

function worldEditor(id) {
  const w = id ? (state.activeWorld?.id === id ? state.activeWorld : storage.loadWorld(id)) : { id: null, name: '', mode: 'new', description: '' };
  const body = `
    <div class="field"><label>World name</label><input type="text" id="w-name" value="${escapeAttr(w.name)}" placeholder="e.g. The Hollow Coast" /></div>
    <div class="field">
      <label>Type</label>
      <div class="mode-choice" id="w-mode">
        <label class="${w.mode !== 'jumpin' ? 'sel' : ''}"><input type="radio" name="wm" value="new" ${w.mode !== 'jumpin' ? 'checked' : ''} />New World<span class="mode-sub">An original setting you invent.</span></label>
        <label class="${w.mode === 'jumpin' ? 'sel' : ''}"><input type="radio" name="wm" value="jumpin" ${w.mode === 'jumpin' ? 'checked' : ''} />Jump In<span class="mode-sub">Based on existing media; canon is honored.</span></label>
      </div>
    </div>
    <div class="field"><label>Description / premise</label><textarea id="w-desc" placeholder="The setting, tone, and situation of this world.">${escapeHtml(w.description)}</textarea></div>`;
  const foot = `<button class="btn ghost" data-back-worlds>Back</button><button class="btn primary" data-save-world>Save</button>`;
  const modal = openModal(modalShell(id ? 'Edit world' : 'New world', body, foot));
  modal.querySelectorAll('#w-mode label').forEach((lab) => (lab.onclick = () => { modal.querySelectorAll('#w-mode label').forEach((l) => l.classList.remove('sel')); lab.classList.add('sel'); lab.querySelector('input').checked = true; }));
  modal.querySelector('[data-save-world]').onclick = () => {
    const name = modal.querySelector('#w-name').value.trim() || 'New world';
    const mode = modal.querySelector('#w-mode input:checked').value;
    const description = modal.querySelector('#w-desc').value.trim();
    if (id) {
      const target = state.activeWorld?.id === id ? state.activeWorld : storage.loadWorld(id);
      Object.assign(target, { name, mode, description, updatedAt: Date.now() });
      if (state.activeWorld?.id === id) { persistWorld(); } else { storage.saveWorld(target); const mi = state.worldMetas.findIndex((m) => m.id === id); if (mi >= 0) state.worldMetas[mi] = worldMeta(target); persistIndex(); }
    } else {
      const world = W.createWorld({ name, mode, description });
      storage.saveWorld(world);
      state.worldMetas.push(worldMeta(world));
      state.activeWorld = world;
      state.activeChat = null;
      state.activeChatId = null;
      persistIndex();
    }
    renderAll();
    openWorlds();
  };
  modal.querySelector('[data-back-worlds]').onclick = openWorlds;
}

function switchWorld(id) {
  const w = storage.loadWorld(id);
  if (!w) return toast('That world could not be loaded.', 'err');
  state.activeWorld = w;
  const next = state.chatMetas.filter((m) => m.worldId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (next) { state.activeChat = storage.loadChat(next.id); state.activeChatId = next.id; }
  else { state.activeChat = null; state.activeChatId = null; }
  state.editingId = null;
  persistIndex();
  renderAll();
  closeModal();
}

function confirmDeleteWorld(id) {
  const meta = state.worldMetas.find((m) => m.id === id);
  const chatCount = state.chatMetas.filter((m) => m.worldId === id).length;
  openConfirm({
    title: 'Delete world', body: `Delete “${meta?.name || 'this world'}”, its cast, its lore, its memory, and its ${chatCount} scene${chatCount === 1 ? '' : 's'}? This can't be undone.`,
    danger: true, confirmLabel: 'Delete world',
    onConfirm: () => {
      for (const m of state.chatMetas.filter((x) => x.worldId === id)) storage.removeChat(m.id);
      state.chatMetas = state.chatMetas.filter((m) => m.worldId !== id);
      storage.removeWorld(id);
      state.worldMetas = state.worldMetas.filter((m) => m.id !== id);
      if (state.activeWorld?.id === id) {
        const nextW = state.worldMetas[0] ? storage.loadWorld(state.worldMetas[0].id) : null;
        state.activeWorld = nextW;
        state.activeChat = null;
        state.activeChatId = null;
      }
      persistIndex();
      renderAll();
      openWorlds();
    },
  });
}

async function importWorld() {
  const file = await pickFile({ accept: '.json,application/json', as: 'text' });
  if (!file) return;
  try {
    const raw = JSON.parse(file.data);
    // Accept a full-world export, or a bare world object.
    const world = raw.world && raw.world.cast ? raw.world : raw;
    if (!world || !Array.isArray(world.cast)) return toast('That is not a world file.', 'err');
    world.id = tree.makeId();
    world.cast = world.cast.map((c) => ({ ...c, id: c.id || tree.makeId() }));
    world.lorebook = (world.lorebook || []).map((e) => ({ ...e, id: e.id || tree.makeId() }));
    world.facts = world.facts || [];
    world.updatedAt = Date.now();
    storage.saveWorld(world);
    state.worldMetas.push(worldMeta(world));
    persistIndex();
    toast(`Imported world “${world.name}”.`, 'ok');
    openWorlds();
  } catch (err) {
    toast('Could not import that world file.', 'err');
  }
}

/* ── Cast ─────────────────────────────────────────────────────────────────── */

function openCast() {
  if (!state.activeWorld) { toast('Create a world first.'); return openWorlds(); }
  const rows = state.activeWorld.cast
    .map((c) => `
      <div class="list-row">
        <div class="row-avatar">${avatarMarkup(c.avatar, '🎭')}</div>
        <div class="row-main"><div class="row-name">${escapeHtml(c.name)}</div><div class="row-sub">${escapeHtml((c.description || '').slice(0, 80) || 'No description')}</div></div>
        <div class="row-acts">
          <button class="mini-btn" data-edit-cast="${escapeAttr(c.id)}">Edit</button>
          <button class="mini-btn danger" data-del-cast="${escapeAttr(c.id)}">Delete</button>
        </div>
      </div>`)
    .join('') || '<p class="modal-note">No cast yet. Add the characters the AI will play.</p>';
  const foot = `<button class="btn ghost" data-close>Close</button><button class="btn" data-import-cast>⭱ Import card</button><button class="btn primary" data-new-cast>＋ New character</button>`;
  const modal = openModal(modalShell(`Cast of ${state.activeWorld.name}`, rows, foot, { wide: true }));
  modal.querySelectorAll('[data-edit-cast]').forEach((b) => (b.onclick = () => castEditor(b.dataset.editCast)));
  modal.querySelectorAll('[data-del-cast]').forEach((b) => (b.onclick = () => confirmDeleteCast(b.dataset.delCast)));
  modal.querySelector('[data-new-cast]').onclick = () => castEditor(null);
  modal.querySelector('[data-import-cast]').onclick = importCharacter;
}

function castEditor(id) {
  const c = id ? castById(id) : { id: null, name: '', avatar: '🎭', description: '', personality: '', scenario: '', greeting: '', exampleDialogue: '' };
  const body = `
    <div class="field-row">
      <div class="field" style="flex:0 0 120px;"><label>Avatar</label><input type="text" id="c-avatar" value="${escapeAttr(c.avatar)}" placeholder="🎭 or URL" /></div>
      <div class="field"><label>Name</label><input type="text" id="c-name" value="${escapeAttr(c.name)}" placeholder="Character name" /></div>
    </div>
    <div class="field"><label>Description</label><textarea id="c-desc" placeholder="Who they are, appearance, background…">${escapeHtml(c.description)}</textarea></div>
    <div class="field"><label>Personality</label><textarea id="c-pers" placeholder="Traits, voice, quirks…">${escapeHtml(c.personality)}</textarea></div>
    <div class="field"><label>Greeting (used to open a solo scene)</label><textarea id="c-greet" placeholder="Optional opening line. *Actions in asterisks.*">${escapeHtml(c.greeting)}</textarea></div>
    <div class="field"><label>Example dialogue (optional)</label><textarea id="c-ex" placeholder="{{user}}: …&#10;{{char}}: …">${escapeHtml(c.exampleDialogue)}</textarea></div>`;
  const foot = `${id ? '<button class="btn ghost" data-export-cast>⭳ Export</button>' : ''}<button class="btn ghost" data-back-cast>Back</button><button class="btn primary" data-save-cast>Save</button>`;
  const modal = openModal(modalShell(id ? 'Edit character' : 'New character', body, foot, { wide: true }));
  modal.querySelector('[data-save-cast]').onclick = () => {
    const g = (sel) => modal.querySelector(sel).value;
    const data = { name: g('#c-name').trim() || 'Unnamed', avatar: g('#c-avatar').trim() || '🎭', description: g('#c-desc').trim(), personality: g('#c-pers').trim(), greeting: g('#c-greet'), exampleDialogue: g('#c-ex') };
    if (id) { Object.assign(castById(id), data); }
    else { W.addCharacter(state.activeWorld, W.createCharacter(data)); }
    persistWorld();
    renderHeader();
    renderMessages();
    openCast();
  };
  modal.querySelector('[data-back-cast]').onclick = openCast;
  const exp = modal.querySelector('[data-export-cast]');
  if (exp) exp.onclick = () => {
    const ch = castById(id);
    const card = { spec: 'chara_card_v2', data: { name: ch.name, description: ch.description, personality: ch.personality, scenario: ch.scenario || '', first_mes: ch.greeting, mes_example: ch.exampleDialogue } };
    download(`${(ch.name || 'character').replace(/\s+/g, '_')}.json`, JSON.stringify(card, null, 2));
  };
}

async function importCharacter() {
  const file = await pickFile({ accept: '.json,.png,image/png,application/json', as: 'arraybuffer' });
  if (!file) return;
  try {
    let card;
    const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
    if (isPng) { card = extractCardFromPng(file.data); card.avatar = `data:image/png;base64,${arrayBufferToBase64(file.data)}`; }
    else { card = normalizeCard(JSON.parse(new TextDecoder().decode(new Uint8Array(file.data)))); }
    if (!card) return toast('No character data found in that file.', 'err');
    W.addCharacter(state.activeWorld, W.createCharacter({ name: card.name || 'Imported', avatar: card.avatar || '🎭', description: card.description, personality: card.personality, scenario: card.scenario, greeting: card.greeting, exampleDialogue: card.exampleDialogue }));
    persistWorld();
    toast(`Added ${card.name || 'character'} to the cast.`, 'ok');
    openCast();
  } catch (err) {
    toast(err.message || 'Import failed.', 'err');
  }
}

function confirmDeleteCast(id) {
  const c = castById(id);
  openConfirm({
    title: 'Remove character', body: `Remove “${c?.name || 'this character'}” from the cast? Their facts stay in memory.`,
    danger: true, confirmLabel: 'Remove',
    onConfirm: () => {
      state.activeWorld.cast = state.activeWorld.cast.filter((x) => x.id !== id);
      // Drop from any present rosters of loaded chat.
      if (state.activeChat) state.activeChat.presentCast = (state.activeChat.presentCast || []).filter((x) => x !== id);
      persistWorld();
      if (state.activeChat) persistChat(state.activeChat);
      renderAll();
      openCast();
    },
  });
}

/* ── Lore ─────────────────────────────────────────────────────────────────── */

function openLore() {
  if (!state.activeWorld) { toast('Create a world first.'); return openWorlds(); }
  const rows = state.activeWorld.lorebook
    .map((e) => `
      <div class="list-row">
        <div class="row-main">
          <div class="row-name">${escapeHtml(e.name || (e.always ? 'Always-on entry' : 'Lore entry'))} ${e.always ? '· <span style="color:var(--accent)">always</span>' : ''} ${e.enabled === false ? '· <span style="color:var(--text-faint)">off</span>' : ''}</div>
          <div class="row-sub">${escapeHtml((e.content || '').slice(0, 90))}</div>
          ${!e.always && e.keys?.length ? `<div class="lore-keys">keys: ${escapeHtml(e.keys.join(', '))}</div>` : ''}
        </div>
        <div class="row-acts"><button class="mini-btn" data-edit-lore="${escapeAttr(e.id)}">Edit</button><button class="mini-btn danger" data-del-lore="${escapeAttr(e.id)}">Delete</button></div>
      </div>`)
    .join('') || '<p class="modal-note">No lore yet. Lore entries are injected into the scene when their keywords come up (or always, if you mark them so).</p>';
  const foot = `<button class="btn ghost" data-close>Close</button><button class="btn primary" data-new-lore>＋ New entry</button>`;
  const modal = openModal(modalShell(`Lorebook — ${state.activeWorld.name}`, rows, foot, { wide: true }));
  modal.querySelectorAll('[data-edit-lore]').forEach((b) => (b.onclick = () => loreEditor(b.dataset.editLore)));
  modal.querySelectorAll('[data-del-lore]').forEach((b) => (b.onclick = () => { state.activeWorld.lorebook = state.activeWorld.lorebook.filter((x) => x.id !== b.dataset.delLore); persistWorld(); openLore(); }));
  modal.querySelector('[data-new-lore]').onclick = () => loreEditor(null);
}

function loreEditor(id) {
  const e = id ? state.activeWorld.lorebook.find((x) => x.id === id) : { id: null, name: '', keys: [], content: '', always: false, enabled: true };
  const body = `
    <div class="field"><label>Name (optional)</label><input type="text" id="l-name" value="${escapeAttr(e.name)}" placeholder="e.g. The Drowned Bell" /></div>
    <div class="field"><label>Trigger keywords (comma-separated)</label><input type="text" id="l-keys" value="${escapeAttr((e.keys || []).join(', '))}" placeholder="bell, drowned bell, ruins" />
      <div class="hint">The entry is added to context when any keyword appears in the recent conversation.</div></div>
    <div class="field"><label>Content</label><textarea id="l-content" placeholder="The lore the model should know when this triggers.">${escapeHtml(e.content)}</textarea></div>
    <div class="field"><label><input type="checkbox" id="l-always" ${e.always ? 'checked' : ''} /> Always inject (ignore keywords)</label></div>
    <div class="field"><label><input type="checkbox" id="l-enabled" ${e.enabled !== false ? 'checked' : ''} /> Enabled</label></div>`;
  const foot = `<button class="btn ghost" data-back-lore>Back</button><button class="btn primary" data-save-lore>Save</button>`;
  const modal = openModal(modalShell(id ? 'Edit lore' : 'New lore', body, foot));
  modal.querySelector('[data-save-lore]').onclick = () => {
    const data = { name: modal.querySelector('#l-name').value.trim(), keys: W.splitKeys(modal.querySelector('#l-keys').value), content: modal.querySelector('#l-content').value.trim(), always: modal.querySelector('#l-always').checked, enabled: modal.querySelector('#l-enabled').checked };
    if (id) { Object.assign(e, data); } else { W.addLoreEntry(state.activeWorld, data); }
    persistWorld();
    openLore();
  };
  modal.querySelector('[data-back-lore]').onclick = openLore;
}

/* ── Memory panel ─────────────────────────────────────────────────────────── */

function openMemory() {
  const world = state.activeWorld;
  const chat = state.activeChat;
  if (!world) { toast('Create a world first.'); return openWorlds(); }
  const summary = chat?.summary || '';
  const facts = world.facts;
  const factHtml = facts.length
    ? facts.slice().reverse().map((f) => {
        const who = W.knownByNames(world, f);
        return `<div class="fact-row"><div class="fact-text">${escapeHtml(f.text)}<div class="fact-who ${f.everyone ? 'everyone' : ''}">known by ${escapeHtml(who.join(', '))}</div></div>
          <div class="fact-acts"><button class="mini-btn" data-toggle-fact="${escapeAttr(f.id)}" title="Toggle known-by-everyone">${f.everyone ? 'Make private' : 'Make world-truth'}</button><button class="mini-btn danger" data-del-fact="${escapeAttr(f.id)}">✕</button></div></div>`;
      }).join('')
    : '<p class="mem-empty">No facts recorded yet. As you play, revealed facts are filed here — and gated by who was present.</p>';

  const body = `
    <div class="field">
      <label>Story so far ${chat ? '' : '(open a scene to edit)'}</label>
      <textarea class="mem-summary" id="mem-summary" ${chat ? '' : 'disabled'} placeholder="A running summary builds automatically as scenes get long. You can also edit it by hand.">${escapeHtml(summary)}</textarea>
      <div class="inline-actions" style="margin-top:8px;">
        <button class="btn" data-summarize ${chat ? '' : 'disabled'}>Summarize now</button>
        <button class="btn" data-extract ${chat ? '' : 'disabled'}>Extract from last exchange</button>
        <button class="btn ghost" data-save-summary ${chat ? '' : 'disabled'}>Save summary</button>
      </div>
    </div>
    <div class="divider"></div>
    <label style="font-size:13px;color:var(--text-dim);font-weight:550;">Known facts (${facts.length})</label>
    <p class="modal-note">Each fact remembers who knows it. A scene only shows the model the facts its present cast knows.</p>
    <div id="fact-list">${factHtml}</div>`;
  const modal = openModal(modalShell(`Memory — ${world.name}`, body, '<button class="btn primary" data-close>Done</button>', { wide: true }));

  const wire = () => {
    modal.querySelectorAll('[data-toggle-fact]').forEach((b) => (b.onclick = () => { const f = world.facts.find((x) => x.id === b.dataset.toggleFact); if (f) { W.setFactEveryone(world, f.id, !f.everyone); persistWorld(); openMemory(); } }));
    modal.querySelectorAll('[data-del-fact]').forEach((b) => (b.onclick = () => { W.deleteFact(world, b.dataset.delFact); persistWorld(); renderUsage(); openMemory(); }));
  };
  wire();
  const sum = modal.querySelector('[data-summarize]');
  if (sum) sum.onclick = async () => { await runSummary(false); openMemory(); };
  const ext = modal.querySelector('[data-extract]');
  if (ext) ext.onclick = async () => { await runExtraction(false); openMemory(); };
  const save = modal.querySelector('[data-save-summary]');
  if (save) save.onclick = () => { if (chat) { chat.summary = modal.querySelector('#mem-summary').value; persistChat(chat); toast('Summary saved.', 'ok'); } };
}

/* ── Personas ─────────────────────────────────────────────────────────────── */

function openPersonas() {
  const rows = state.personas
    .map((p) => `
      <div class="list-row ${p.id === state.activePersonaId ? 'active' : ''}">
        <div class="row-avatar">${avatarMarkup(p.avatar, '🧑')}</div>
        <div class="row-main"><div class="row-name">${escapeHtml(p.name || 'Unnamed')}</div><div class="row-sub">${escapeHtml((p.description || '').slice(0, 80) || 'No description')}</div></div>
        <div class="row-acts"><button class="mini-btn" data-use-persona="${escapeAttr(p.id)}">Use</button><button class="mini-btn" data-edit-persona="${escapeAttr(p.id)}">Edit</button><button class="mini-btn danger" data-del-persona="${escapeAttr(p.id)}">Delete</button></div>
      </div>`)
    .join('') || '<p class="modal-note">No personas yet.</p>';
  const foot = `<button class="btn ghost" data-close>Close</button><button class="btn primary" data-new-persona>＋ New persona</button>`;
  const modal = openModal(modalShell('Your personas', rows, foot));
  modal.querySelectorAll('[data-use-persona]').forEach((b) => (b.onclick = () => selectPersona(b.dataset.usePersona)));
  modal.querySelectorAll('[data-edit-persona]').forEach((b) => (b.onclick = () => personaEditor(b.dataset.editPersona)));
  modal.querySelectorAll('[data-del-persona]').forEach((b) => (b.onclick = () => confirmDeletePersona(b.dataset.delPersona)));
  modal.querySelector('[data-new-persona]').onclick = () => personaEditor(null);
}

function personaEditor(id) {
  const p = id ? state.personas.find((x) => x.id === id) : { id: null, name: '', avatar: '🧑', description: '' };
  const body = `
    <div class="field-row">
      <div class="field" style="flex:0 0 120px;"><label>Avatar</label><input type="text" id="p-avatar" value="${escapeAttr(p.avatar)}" placeholder="🧑 or URL" /></div>
      <div class="field"><label>Name</label><input type="text" id="p-name" value="${escapeAttr(p.name)}" placeholder="How the cast refers to you" /></div>
    </div>
    <div class="field"><label>About you (optional)</label><textarea id="p-desc" placeholder="Who you're playing.">${escapeHtml(p.description)}</textarea></div>`;
  const foot = `<button class="btn ghost" data-back-personas>Back</button><button class="btn primary" data-save-persona>Save</button>`;
  const modal = openModal(modalShell(id ? 'Edit persona' : 'New persona', body, foot));
  modal.querySelector('[data-save-persona]').onclick = () => {
    const data = { name: modal.querySelector('#p-name').value.trim() || 'You', avatar: modal.querySelector('#p-avatar').value.trim() || '🧑', description: modal.querySelector('#p-desc').value.trim() };
    if (id) { Object.assign(state.personas.find((x) => x.id === id), data); }
    else { const created = { id: tree.makeId(), ...data }; state.personas.push(created); if (!state.activePersonaId) state.activePersonaId = created.id; }
    persistIndex();
    renderHeader();
    renderMessages();
    openPersonas();
  };
  modal.querySelector('[data-back-personas]').onclick = openPersonas;
}

function selectPersona(id) {
  state.activePersonaId = id;
  if (state.activeChat) { state.activeChat.personaId = id; persistChat(state.activeChat); }
  persistIndex();
  renderHeader();
  renderMessages();
  closeModal();
}

function confirmDeletePersona(id) {
  const p = state.personas.find((x) => x.id === id);
  openConfirm({
    title: 'Delete persona', body: `Delete “${p?.name || 'this persona'}”?`, danger: true, confirmLabel: 'Delete',
    onConfirm: () => { state.personas = state.personas.filter((x) => x.id !== id); if (state.activePersonaId === id) state.activePersonaId = state.personas[0]?.id || null; persistIndex(); renderHeader(); openPersonas(); },
  });
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

function openSettings() {
  const s = state.settings;
  const datalist = SUGGESTED_MODELS.map((m) => `<option value="${escapeAttr(m)}"></option>`).join('');
  const body = `
    <div class="field"><label>OpenRouter API key</label><input type="password" id="f-key" value="${escapeAttr(s.apiKey)}" placeholder="sk-or-v1-…" autocomplete="off" />
      <div class="hint">Stored only in this browser. Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>.</div></div>
    <div class="field"><label>Model</label><input type="text" id="f-model" value="${escapeAttr(s.model)}" list="model-suggestions" placeholder="author/model-name" /><datalist id="model-suggestions">${datalist}</datalist>
      <div class="hint">Copy the exact ID from <a href="https://openrouter.ai/models" target="_blank" rel="noopener">openrouter.ai/models</a>.</div></div>
    <div class="field"><label>Memory model (optional)</label><input type="text" id="f-umodel" value="${escapeAttr(s.utilityModel)}" list="model-suggestions" placeholder="blank = same as model" />
      <div class="hint">Used for fact extraction and summaries. A cheaper model here saves money.</div></div>
    <div class="field-row">
      <div class="field"><label>Temperature</label><input type="number" id="f-temp" step="0.05" min="0" max="2" value="${s.temperature}" /></div>
      <div class="field"><label>Max reply tokens</label><input type="number" id="f-max" step="16" min="16" value="${s.maxTokens}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Top-p</label><input type="number" id="f-topp" step="0.05" min="0" max="1" value="${s.topP}" /></div>
      <div class="field"><label>Context budget (tokens)</label><input type="number" id="f-ctx" step="256" min="512" value="${s.contextTokens}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Frequency penalty</label><input type="number" id="f-freq" step="0.05" min="-2" max="2" value="${s.frequencyPenalty}" /></div>
      <div class="field"><label>Presence penalty</label><input type="number" id="f-pres" step="0.05" min="-2" max="2" value="${s.presencePenalty}" /></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f-stream" ${s.stream ? 'checked' : ''} /> Stream replies as they generate</label></div>
    <div class="divider"></div>
    <label style="font-size:13px;color:var(--text-dim);font-weight:550;">Memory</label>
    <div class="field" style="margin-top:8px;"><label><input type="checkbox" id="f-automem" ${s.autoMemory ? 'checked' : ''} /> Automatically remember facts after each reply</label></div>
    <div class="field"><label><input type="checkbox" id="f-autosum" ${s.autoSummary ? 'checked' : ''} /> Automatically summarize long scenes</label></div>
    <div class="field"><label>Summarize after (tokens of live scene)</label><input type="number" id="f-sumthresh" step="200" min="600" value="${s.summaryThreshold}" /></div>
    <div class="divider"></div>
    <div class="field"><label>Custom endpoint (optional)</label><input type="text" id="f-endpoint" value="${escapeAttr(s.endpoint)}" placeholder="${escapeAttr(api.DEFAULT_ENDPOINT)}" /><div class="hint">Leave blank for OpenRouter.</div></div>
    <div class="field"><label>System prompt prefix (optional)</label><textarea id="f-prefix" placeholder="e.g. Write immersively and stay in character.">${escapeHtml(s.systemPrefix)}</textarea></div>
    <div class="divider"></div>
    <label style="font-size:13px;color:var(--text-dim);font-weight:550;">Backup</label>
    <p class="modal-note">Your worlds and scenes live in this browser only. Export a backup regularly.</p>
    <div class="inline-actions"><button class="btn" data-export>⭳ Export backup</button><button class="btn" data-import>⭱ Import backup</button></div>`;
  const foot = `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save-settings>Save</button>`;
  const modal = openModal(modalShell('Settings', body, foot, { wide: true }));
  modal.querySelector('[data-save-settings]').onclick = () => {
    const g = (id) => modal.querySelector(id);
    const numOr = (v, d) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v));
    state.settings = {
      ...state.settings,
      apiKey: g('#f-key').value.trim(), model: g('#f-model').value.trim(), utilityModel: g('#f-umodel').value.trim(),
      temperature: numOr(g('#f-temp').value, DEFAULT_SETTINGS.temperature), maxTokens: numOr(g('#f-max').value, DEFAULT_SETTINGS.maxTokens),
      topP: numOr(g('#f-topp').value, DEFAULT_SETTINGS.topP), contextTokens: numOr(g('#f-ctx').value, DEFAULT_SETTINGS.contextTokens),
      frequencyPenalty: numOr(g('#f-freq').value, 0), presencePenalty: numOr(g('#f-pres').value, 0),
      stream: g('#f-stream').checked, autoMemory: g('#f-automem').checked, autoSummary: g('#f-autosum').checked,
      summaryThreshold: numOr(g('#f-sumthresh').value, DEFAULT_SETTINGS.summaryThreshold),
      endpoint: g('#f-endpoint').value.trim(), systemPrefix: g('#f-prefix').value,
    };
    persistIndex();
    renderHeader();
    closeModal();
    toast('Settings saved.', 'ok');
  };
  modal.querySelector('[data-export]').onclick = exportBackup;
  modal.querySelector('[data-import]').onclick = importBackup;
}

/* ── Confirm & backup ─────────────────────────────────────────────────────── */

function openConfirm({ title, body, danger, confirmLabel = 'Confirm', onConfirm }) {
  const foot = `<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmLabel)}</button>`;
  const modal = openModal(modalShell(title, `<p style="margin:0;color:var(--text-dim);">${escapeHtml(body)}</p>`, foot));
  modal.querySelector('[data-confirm]').onclick = () => { closeModal(); onConfirm?.(); };
}

function exportBackup() {
  try {
    const bundle = storage.exportAll();
    download(`solo-rp-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
    toast('Backup downloaded.', 'ok');
  } catch { toast('Export failed.', 'err'); }
}

async function importBackup() {
  const file = await pickFile({ accept: '.json,application/json', as: 'text' });
  if (!file) return;
  openConfirm({
    title: 'Import backup', body: 'This replaces all current worlds, scenes, personas and settings with the backup. Continue?',
    danger: true, confirmLabel: 'Replace everything',
    onConfirm: () => {
      try {
        storage.importAll(JSON.parse(file.data));
        state.activeChat = null; state.activeChatId = null; state.activeWorld = null; state.editingId = null;
        hydrate();
        renderAll();
        closeModal();
        toast('Backup restored.', 'ok');
      } catch (err) { toast(err.message || 'That file is not a valid backup.', 'err'); }
    },
  });
}

/* ── Composer plumbing ────────────────────────────────────────────────────── */

function autoGrow() {
  const t = el.input;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
}
function updateComposer() { el.input.disabled = false; el.btnSend.disabled = state.generating; }
function scrollToBottom() { el.messages.scrollTop = el.messages.scrollHeight; }
function scrollToBottomIfNear() { const m = el.messages; if (m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight; }
function closeSidebarMobile() { el.sidebar.classList.remove('open'); }

/* ── Wiring ───────────────────────────────────────────────────────────────── */

function cacheDom() {
  el.sidebar = $('sidebar');
  el.worldSwitch = $('world-switch');
  el.worldSwitchName = $('world-switch-name');
  el.worldSwitchMode = $('world-switch-mode');
  el.worldSwitchIcon = $('world-switch-icon');
  el.chatList = $('chat-list');
  el.btnNewChat = $('btn-new-chat');
  el.btnCast = $('btn-cast');
  el.btnLore = $('btn-lore');
  el.btnMemory = $('btn-memory');
  el.btnPersonas = $('btn-personas');
  el.btnSettings = $('btn-settings');
  el.btnMenu = $('btn-menu');
  el.btnSidebar = $('btn-sidebar');
  el.chatTitle = $('chat-title');
  el.presentCast = $('present-cast');
  el.headerPersona = $('header-persona');
  el.headerModel = $('header-model');
  el.btnDeleteChat = $('btn-delete-chat');
  el.btnBranchMenu = $('btn-branch-menu');
  el.messages = $('messages');
  el.input = $('input');
  el.btnSend = $('btn-send');
  el.btnStop = $('btn-stop');
  el.genStatus = $('gen-status');
  el.btnOpening = $('btn-opening');
  el.btnRegenerate = $('btn-regenerate');
  el.btnContinue = $('btn-continue');
  el.btnImpersonate = $('btn-impersonate');
  el.usageNote = $('usage-note');
  el.modalRoot = $('modal-root');
  el.toasts = $('toasts');
  el.fileInput = $('file-input');
}

function wireEvents() {
  el.btnSend.onclick = send;
  el.btnStop.onclick = stopGenerating;
  el.btnNewChat.onclick = newScene;
  el.btnCast.onclick = openCast;
  el.btnLore.onclick = openLore;
  el.btnMemory.onclick = openMemory;
  el.btnPersonas.onclick = openPersonas;
  el.btnSettings.onclick = openSettings;
  el.worldSwitch.onclick = openWorlds;
  el.btnOpening.onclick = openingLine;
  el.btnRegenerate.onclick = regenerateLast;
  el.btnContinue.onclick = continueLast;
  el.btnImpersonate.onclick = impersonate;
  el.btnDeleteChat.onclick = () => state.activeChatId && confirmDeleteChat(state.activeChatId);
  el.btnBranchMenu.onclick = () => { const id = tree.leafId(state.activeChat); if (id) branchFrom(id); };
  el.btnMenu.onclick = () => el.sidebar.classList.toggle('open');
  el.btnSidebar.onclick = () => el.sidebar.classList.toggle('open');

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  el.chatTitle.addEventListener('change', renameActiveChat);
  el.chatTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.chatTitle.blur(); } });

  el.messages.addEventListener('click', onMessagesClick);

  el.presentCast.addEventListener('click', (e) => {
    const leave = e.target.closest('[data-leave]');
    if (leave) return toggleCastPresence(leave.dataset.leave, false);
    if (e.target.closest('[data-add-cast]')) return openAddCastPicker();
  });

  el.chatList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-chat]');
    if (del) { e.stopPropagation(); return confirmDeleteChat(del.dataset.delChat); }
    const item = e.target.closest('[data-chat]');
    if (item) openScene(item.dataset.chat);
  });

  el.modalRoot.addEventListener('click', (e) => { if (e.target === el.modalRoot || e.target.closest('[data-close]')) closeModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!el.modalRoot.classList.contains('hidden')) closeModal(); else if (state.editingId) cancelEdit(); }
  });
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

function boot() {
  cacheDom();
  hydrate();
  wireEvents();
  renderAll();
  autoGrow();
}

if (typeof document !== 'undefined' && document.getElementById('sidebar')) boot();

export { boot, state };
