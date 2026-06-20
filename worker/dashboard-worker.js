// ============================================================================
// PASTE-READY Cloudflare Worker for the Obsession wiki "Ask the Rulebook" chat.
//
// Plain-JavaScript copy of src/index.ts — paste straight into the Cloudflare
// dashboard editor (Workers & Pages -> your worker -> "Edit code"), no build step.
//
// It keeps your Anthropic key server-side AND feeds the AI the COMPLETE Obsession
// reference, which it fetches from your deployed wiki (ai-knowledge.txt). So the AI
// answers from the full wiki content and updates automatically when the wiki rebuilds.
//
// After deploying, set these in the worker's Settings -> "Variables and Secrets":
//   * Secret    ANTHROPIC_API_KEY = your sk-ant-... key   (encrypted)
//   * Variable  ALLOWED_ORIGIN    = https://d5nf9kcskk-byte.github.io
//   * Variable  KNOWLEDGE_URL     = https://d5nf9kcskk-byte.github.io/obsession-wiki/ai-knowledge.txt
//                                   (optional — this is also the built-in default)
// ============================================================================

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1500;
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;

const DEFAULT_KNOWLEDGE_URL = 'https://d5nf9kcskk-byte.github.io/obsession-wiki/ai-knowledge.txt';
const KNOWLEDGE_TTL_MS = 60 * 60 * 1000; // 1 hour

const INSTRUCTIONS = `You are the definitive rules expert for the board game Obsession (designed by Dan Hallagan, Kayenta Games), including all of its expansions. A complete reference document is provided below under "OBSESSION REFERENCE".

How to answer:
- Answer the player's question directly and completely using the reference. You ARE the rulebook — NEVER tell the user to "consult the rulebook", "check the manual", "refer to the rules", or figure it out themselves. Just give the answer.
- Be specific: cite exact tile, card, servant, and family names, plus costs, VP values, reputation requirements, servant/guest requirements, and round numbers.
- When the FAQ / official clarifications cover the question, follow them.
- If an exact edge case is not explicitly in the reference, reason from the closest applicable rules and briefly note that it is an interpretation rather than a printed rule.
- Keep answers focused and well-organized; use short lists when they make the answer clearer.`;

// Minimal correct fallback used only if the full reference can't be fetched.
const FALLBACK_KNOWLEDGE = `Obsession is a 1–4 player tile-placement/deck game set in 1860s Victorian Derbyshire; over 16 rounds (20 extended) players host activities, invite gentry guests, renovate their estate, and manage servants to score Victory Points.

SERVANTS & SUBSTITUTION: Butler (formal activities; substituted by Underbutler). Valet (male guests; substituted by Underbutler; a Footman may sub with the Brushing Room tile). Lady's Maid (female guests; substituted by Housekeeper). Housekeeper (dining; can sub for Lady's Maid). Footman (outdoor/estate; substituted by Underbutler). Underbutler (subs for Butler, Valet, or Footman). Upstairs/Downstairs adds Cook, Hall Boy (subs for Butler/Footman), Head Housemaid, Useful Man. Servants cool down ~2 rounds after use.

PASS ACTION: retrieve your discard pile, reset all servants to available, and choose EITHER gain £200 OR refresh the Builder's Market; you may also hire servants.

SPECIAL ROUNDS (standard/extended): Village Fair (3,9 / 4,9,16) — Private Study holders gain £300 +2 Rep. Courtship (4,8,12,16 / 5,10,15,20) — score VP of tiles matching the revealed theme category; winner takes a Fairchild card (8 VP) and a VP card; tiebreaker is reputation. Builder's Holiday (11 / 13) — buy unlimited tiles. National Holiday (14 / 11) — all reputation/prestige restrictions removed.

SCORING: tiles (printed VP), gentry cards (printed VP), objective cards, servants (2 VP each), wealth (1 VP per £200), Courtship VP cards, and reputation (scales up to ~45 VP at level 7).

(The full reference could not be loaded; answer from these essentials and general Obsession knowledge, and do not tell the user to consult the rulebook.)`;

let cachedKnowledge = null;
let cachedAt = 0;

async function getKnowledge(env) {
  const now = Date.now();
  if (cachedKnowledge && now - cachedAt < KNOWLEDGE_TTL_MS) return cachedKnowledge;
  const url = env.KNOWLEDGE_URL || DEFAULT_KNOWLEDGE_URL;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 500) {
        cachedKnowledge = text;
        cachedAt = now;
        return text;
      }
    }
  } catch {
    // network error — fall back to stale cache or the built-in essentials
  }
  return cachedKnowledge || FALLBACK_KNOWLEDGE;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin, allowList) {
  const allow = origin && allowList.includes(origin) ? origin : (allowList[0] || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const allowList = (env.ALLOWED_ORIGIN || 'https://d5nf9kcskk-byte.github.io')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, allowList);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (origin && !allowList.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }, 500, cors);

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'anon';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Rate limit exceeded. Please slow down and try again.' }, 429, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, cors);
    }

    const raw = body.messages;
    if (!Array.isArray(raw) || raw.length === 0) return json({ error: '"messages" must be a non-empty array' }, 400, cors);
    if (raw.length > MAX_MESSAGES) return json({ error: 'Conversation too long' }, 400, cors);

    const messages = [];
    for (const m of raw) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        return json({ error: 'Invalid message format' }, 400, cors);
      }
      messages.push({ role: m.role, content: m.content.slice(0, MAX_CHARS) });
    }

    const knowledge = await getKnowledge(env);
    const systemPrompt = `${INSTRUCTIONS}\n\n===== OBSESSION REFERENCE =====\n${knowledge}\n===== END REFERENCE =====`;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages }),
    });

    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
