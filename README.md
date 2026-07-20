# Solo RP

A single-user, no-login roleplay app that runs entirely in your browser. You play
one character; the AI plays a whole cast. Worlds have real depth — a lorebook, and
a persistent memory whose knowledge is gated by who was present — and none of it
needs a server. Because it's just static files, you can host it free on GitHub
Pages. You bring an OpenRouter key; everything you create lives in your browser.

This is the personal, self-hosted successor to a Supabase-backed project. It keeps
that project's depth and drops the entire backend.

---

## Worlds, not just characters

Everything lives inside a **world**:

- **New World vs Jump In** — build an original setting, or base a world on existing
  media (Jump In tells the model to honor that canon).
- **A cast the AI plays.** You define the characters; the AI voices all of them and
  narrates the scene. You play your **persona**. A scene has a **present roster** —
  who's actually in the room — which you change with chips in the header or with
  `/join` and `/leave`.
- **Lorebook (the world bible).** Write entries with trigger keywords; an entry is
  injected into context only when its keywords come up in play (or mark it
  *always-on*). This keeps deep worlds affordable — the model only sees what's
  relevant right now.
- **Persistent, presence-gated memory.** This is the heart of it. As you play, the
  app extracts the durable facts a scene establishes and files them into the
  world's memory, **attributed to whoever was present**. A fact revealed to the
  people in a room is known to exactly them going forward — a character who wasn't
  there won't know it until they're told. When a scene is built, the model is only
  handed the facts its present cast actually know. Long scenes are also folded into
  a rolling "story so far" summary so a thread can run effectively forever without
  losing the plot.

### Commands

Type these in the composer:

| Command | What it does |
|---|---|
| `/recap` | Write a "story so far" recap of the current scene. |
| `/whoknows [text]` | List facts (optionally matching text) and who knows them. |
| `/join [name]` | Bring a cast member into the scene. |
| `/leave [name]` | Remove a cast member from the scene. |
| `/remember [fact]` | File a fact, known to whoever is present. |
| `/correct [fact]` | File a world truth known to everyone (fix a contradiction). |
| `/help` | Show the list. |

## Everything else

- **Full message control**, all non-destructive: edit in place; **edit & rerun**
  (regenerate from an edited message, original kept); **regenerate** with swipe
  navigation **‹ 2/3 ›**; **continue**; **branch** any point into a new scene;
  **impersonate** (the AI drafts your next line); copy; delete.
- **Character-card import** — SillyTavern `.json` and `.png` cards (v1/v2/v3) load
  straight into a world's cast. Export your own too.
- **Streaming** with a stop button, adjustable sampling (temperature, top-p,
  penalties, context budget), an optional system-prompt prefix, and a separate
  cheaper **memory model** for extraction/summaries.
- **Backup & restore** — export every world and scene to one JSON file and import
  it back. Do this regularly; clearing your browser data erases everything.

---

## Getting it online (GitHub Pages)

No build step. You deploy `index.html`, `styles.css`, and the `src/` folder.

1. Push these files to a new GitHub repo (`src/` must sit next to `index.html`).
2. Repo **Settings → Pages**.
3. **Source: Deploy from a branch**, pick your branch, **`/ (root)`**, save.
4. Open the URL Pages gives you (e.g. `https://you.github.io/your-repo/`).

Relative paths are used throughout, so a repo subpath is fine.

> ES modules must be served over http(s). Opening `index.html` from the file
> system (`file://`) won't work — use Pages, or the local server below.

## Setting up the model (OpenRouter)

Solo RP talks to **OpenRouter** for a specific reason: unlike the OpenAI and
Anthropic endpoints, it allows calls **directly from the browser**, which is what
lets this app have no backend. You pay OpenRouter for usage (many models are cheap;
some are free).

1. Make an account at **openrouter.ai** and add a little credit.
2. Create a key at **openrouter.ai/keys**.
3. In the app: **Settings**, paste the key, set a **Model** ID, optionally set a
   cheaper **Memory model** for the background extraction/summary calls.

### Picking an uncensored model

You wanted freedom to write whatever you want. OpenRouter hosts many models tuned
for open-ended adult creative writing that won't break character. Browse
**openrouter.ai/models** (sort by roleplay usage) and copy the exact ID into
Settings. Popular starting points:

- `venice/uncensored` — free tier, a good no-cost start.
- `thedrummer/cydonia-24b-v4.1` — creative-writing tuned, large context.
- `sao10k/l3.3-euryale-70b` — a well-liked 70B roleplay model.
- `neversleep/llama-3-lumimaid-70b` — roleplay-focused, "serious yet uncensored."
- `nousresearch/hermes-3-llama-3.1-70b` — strong, steers well.

Model IDs change and each has its own price and policy — **the exact ID from
openrouter.ai/models is the source of truth**. If a model errors, a wrong ID is
almost always why. You're responsible for what you generate under OpenRouter's
terms and the law; the only bright line, for any model, is nothing sexual involving
minors. Otherwise it's your sandbox.

---

## How the depth works without a backend

The original project ran its memory system on a server (Postgres, vector search,
multiple model passes). A static browser app can't do that, so the same substance
is achieved client-side:

- **Retrieval → keyword lorebook.** Instead of a vector search, lore entries carry
  trigger keywords and are injected when they match recent play. Simple, fast, and
  fully in your control.
- **Fact extraction & summaries → direct model calls.** After a turn, a short call
  to your (optionally cheaper) memory model pulls new facts; when a scene gets long,
  another call folds old turns into the running summary. Both can be toggled off in
  Settings.
- **Knowledge gating → the fact store.** Every fact records the cast ids that know
  it; a scene only receives facts known by its present roster. This is the same
  "who was in the room" propagation the original was built around.

It's not a 1:1 port of a server system, but it delivers the same experience:
a consistent world with a cast, a bible, and a memory that respects who knows what.

---

## Running & developing locally

You don't need Node to *use* it — just serve the folder:

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

The app has no dependencies. The **tests** use Node's built-in tooling + `jsdom`:

```bash
npm install     # jsdom (dev only)
npm test        # all suites
```

Tested: the message tree; prompt assembly and context trimming; the streaming
parser; storage/export/import; SillyTavern card parsing (incl. PNG); the **world
model and presence-gated fact store**; the **memory engine** (commands, extraction
parsing, dedupe, summarization triggers); and a **jsdom run of the whole app** —
world → scene → set the scene → send → streamed reply → memory files a gated fact →
`/leave` → `/remember` → summarize → regenerate → branch → delete → second world →
persistence.

## Files

```
index.html        the app shell
styles.css        styling
src/
  app.js          UI: state, rendering, actions, modals (self-boots)
  world.js        worlds: cast, lorebook, presence-gated fact store
  memory.js       commands, fact extraction, summarization (pure parts)
  tree.js         the message-tree model
  prompt.js       prompt assembly (character and world-aware)
  api.js          OpenRouter streaming client
  storage.js      localStorage persistence + export/import
  card.js         character-card parsing (JSON + PNG)
test/             the suites above
```

## Where your data lives

Everything — worlds, cast, lore, memory, scenes, personas, settings (including your
API key) — is stored in your browser's `localStorage` on the device you're using.
It's never sent anywhere except, during generation, to OpenRouter. It does not sync
across devices. Use **Settings → Export backup** to move it or keep it safe.
