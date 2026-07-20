/**
 * Character cards.
 *
 * The roleplay world shares characters as SillyTavern "cards" — either a JSON
 * file or, more often, a PNG with the character data hidden in a text chunk. This
 * module normalizes both into the handful of fields this app uses, across the v1
 * (flat), v2, and v3 (nested under `data`) card shapes. Kept separate and pure
 * because chunk-walking a PNG is the kind of thing that fails quietly, so it gets
 * its own tests.
 */

/** Map any card shape onto our fields. Returns null if there's nothing usable. */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw.data && typeof raw.data === 'object' ? raw.data : raw; // v2/v3 nest under data

  const firstGreeting =
    d.first_mes || d.first_message || (Array.isArray(d.alternate_greetings) ? d.alternate_greetings[0] : '') || '';

  const card = {
    name: (d.name || raw.name || '').trim(),
    description: (d.description || '').trim(),
    personality: (d.personality || '').trim(),
    scenario: (d.scenario || '').trim(),
    greeting: String(firstGreeting || '').trim(),
    exampleDialogue: (d.mes_example || d.example_dialogue || '').trim(),
  };

  const hasAnything = Object.values(card).some(Boolean);
  return hasAnything ? card : null;
}

/** Read a Big-Endian uint32 from a byte array. */
const u32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Pull the character JSON out of a PNG card. Walks the chunk list looking for a
 * tEXt/iTXt chunk keyed `chara` (v2) or `ccv3` (v3); the value is base64-encoded
 * JSON. Throws if the file isn't a PNG or carries no card.
 */
export function extractCardFromPng(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < PNG_SIG.length; i += 1) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('That file is not a PNG.');
  }

  const decoder = new TextDecoder('latin1');
  let offset = 8;
  let found = null;

  while (offset + 8 <= bytes.length) {
    const length = u32(bytes, offset);
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (type === 'tEXt' || type === 'iTXt') {
      const chunk = bytes.slice(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      const keyword = decoder.decode(chunk.slice(0, nul < 0 ? 0 : nul));
      if (keyword === 'chara' || keyword === 'ccv3') {
        // tEXt: keyword \0 text. iTXt has extra flag bytes; the base64 payload is
        // still the tail, so decode from just after the keyword's NUL and strip
        // anything that isn't base64.
        const rest = chunk.slice((nul < 0 ? 0 : nul) + 1);
        const b64 = decoder.decode(rest).replace(/[^A-Za-z0-9+/=]/g, '');
        found = b64;
        if (keyword === 'ccv3') break; // prefer v3 if present
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip the 4-byte CRC
  }

  if (!found) throw new Error('No character card is embedded in that PNG.');

  let json;
  try {
    const text = decodeBase64Utf8(found);
    json = JSON.parse(text);
  } catch {
    throw new Error('The card data in that PNG is corrupt.');
  }
  const card = normalizeCard(json);
  if (!card) throw new Error('That card has no readable fields.');
  return card;
}

/** base64 → UTF-8 string, working in both the browser and Node. */
function decodeBase64Utf8(b64) {
  const binary = globalThis.atob(b64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}
