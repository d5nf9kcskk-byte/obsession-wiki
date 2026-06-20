/**
 * Cloudflare Worker — Anthropic API proxy for the Obsession wiki "Ask the Rulebook" chat.
 *
 * Keeps the Anthropic API key server-side. The browser POSTs only a conversation
 * (`{ messages: [...] }`); the worker injects the key, model, token cap, and — crucially —
 * the COMPLETE Obsession reference as the system prompt, then forwards to Anthropic.
 *
 * The reference is fetched at runtime from the deployed wiki (ai-knowledge.txt, generated
 * by scripts/build-knowledge.ts from the same data that powers the site). It is cached so
 * it's fetched at most once per hour per isolate. This means the AI always answers from the
 * current wiki content — when the wiki is rebuilt, the AI's knowledge updates automatically.
 */

interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN?: string;
  KNOWLEDGE_URL?: string;
  RATE_LIMITER?: RateLimiter;
}

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

let cachedKnowledge: string | null = null;
let cachedAt = 0;

async function getKnowledge(env: Env): Promise<string> {
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
  return cachedKnowledge ?? FALLBACK_KNOWLEDGE;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin: string | null, allowList: string[]): Record<string, string> {
  const allow = origin && allowList.includes(origin) ? origin : (allowList[0] ?? '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowList = (env.ALLOWED_ORIGIN ?? 'https://d5nf9kcskk-byte.github.io')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, allowList);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }
    if (origin && !allowList.includes(origin)) {
      return json({ error: 'Origin not allowed' }, 403, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }, 500, cors);
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'anon';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json({ error: 'Rate limit exceeded. Please slow down and try again.' }, 429, cors);
      }
    }

    let body: { messages?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, cors);
    }

    const raw = body.messages;
    if (!Array.isArray(raw) || raw.length === 0) {
      return json({ error: '"messages" must be a non-empty array' }, 400, cors);
    }
    if (raw.length > MAX_MESSAGES) {
      return json({ error: 'Conversation too long' }, 400, cors);
    }

    const messages: ChatMessage[] = [];
    for (const m of raw) {
      const mm = m as Partial<ChatMessage>;
      if (!mm || (mm.role !== 'user' && mm.role !== 'assistant') || typeof mm.content !== 'string') {
        return json({ error: 'Invalid message format' }, 400, cors);
      }
      messages.push({ role: mm.role, content: mm.content.slice(0, MAX_CHARS) });
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
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      }),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
