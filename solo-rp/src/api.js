/**
 * Talking to the model.
 *
 * OpenRouter speaks the OpenAI chat-completions dialect and — unlike the OpenAI
 * and Anthropic endpoints — allows calls straight from the browser, which is the
 * whole reason this app can be a static site with no backend. streamChat POSTs the
 * conversation and yields text as it arrives, parsing the server-sent-events
 * stream (skipping the `:` keep-alive comments OpenRouter sends and stopping at
 * the `[DONE]` sentinel). Pass a real fetch in tests to script the stream.
 */

export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function requestBody(messages, settings) {
  const body = {
    model: settings.model,
    messages,
    stream: settings.stream !== false,
    temperature: num(settings.temperature),
    max_tokens: num(settings.maxTokens),
    top_p: num(settings.topP),
    frequency_penalty: num(settings.frequencyPenalty),
    presence_penalty: num(settings.presencePenalty),
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Pull a human-readable message out of an error response body. */
export function readError(status, text) {
  try {
    const j = JSON.parse(text);
    const msg = j.error?.message || j.message || j.error || text;
    return `API error ${status}: ${msg}`;
  } catch {
    return `API error ${status}: ${text?.slice(0, 300) || 'no details'}`;
  }
}

/**
 * Yields chunks of assistant text. Throws on a non-OK response or a missing key.
 * `signal` (an AbortSignal) stops the stream cleanly.
 */
export async function* streamChat({ messages, settings, signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!settings?.apiKey) throw new Error('No API key set. Open Settings and paste your OpenRouter key.');
  if (!settings?.model) throw new Error('No model set. Open Settings and choose a model.');

  const res = await doFetch(settings.endpoint || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      'HTTP-Referer': globalThis.location?.origin || 'https://localhost',
      'X-Title': 'Solo RP',
    },
    body: JSON.stringify(requestBody(messages, settings)),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(readError(res.status, text));
  }

  // Non-streaming: one JSON payload, one yield.
  if (settings.stream === false) {
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (content) yield content;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line || line.startsWith(':')) continue; // blank line or SSE keep-alive comment
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // a partial or non-JSON line; ignore and keep reading
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

/** Convenience: run a stream to completion, calling onToken for each chunk. */
export async function complete({ messages, settings, signal, onToken, fetchImpl }) {
  let full = '';
  for await (const chunk of streamChat({ messages, settings, signal, fetchImpl })) {
    full += chunk;
    onToken?.(chunk, full);
  }
  return full;
}
