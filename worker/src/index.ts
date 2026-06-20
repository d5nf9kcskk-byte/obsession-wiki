/**
 * Cloudflare Worker — Anthropic API proxy for the Obsession wiki "Ask the Rulebook" chat.
 *
 * Purpose: keep the Anthropic API key off the public frontend. The browser POSTs only a
 * conversation (`{ messages: [...] }`) to this worker; the worker injects the key, model,
 * system prompt, and token cap and forwards the request to Anthropic.
 *
 * Because the model / system prompt / max_tokens are fixed here (not client-controlled),
 * the proxy can only be used to ask Obsession rulebook questions — it is not a general
 * free Claude endpoint. CORS is locked to ALLOWED_ORIGIN, and an optional rate-limit
 * binding can be enabled in wrangler.toml.
 */

interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN?: string;
  RATE_LIMITER?: RateLimiter;
}

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;

const SYSTEM_PROMPT = `You are an expert rulebook assistant for Obsession, the Victorian board game by Dan Hallagan (Kayenta Games). Answer questions thoroughly and accurately based on these rules:

SERVANTS (Base game: Butler, Valet, Lady's Maid, Housekeeper, Footman, Underbutler. Upstairs/Downstairs adds: Cook, Hall Boy, Head Housemaid, Useful Man):

SUBSTITUTION RULES:
- Underbutler can substitute for Butler or Valet
- Useful Man (U/D expansion) can substitute for any male servant
- Head Housemaid can substitute for Lady's Maid or Housekeeper
- Hall Boy can substitute for Footman

HIRING SERVANTS:
- On your turn, you may take the "Hire a Servant" action
- Pay the cost from the market (typically £100-£200)
- Servants start in the Servant Hall (unemployed)
- During an activity, servants are assigned from the Servant Hall to the activity tile
- The Underbutler is a special servant that can stand in for Butler or Valet

IMPROVEMENT TILES:
- Each tile specifies required servant types, guest count/gender, and provides favors
- Level 1 (front): base favors. Level 2 (back, after upgrading): enhanced favors
- To host an activity on a tile, you need all required servants available
- Starting tiles: Private Study (no servant), Butler's Room, Main Gazebo, Front Parlour, Bowling Green

FAMILIES:
- Asquith: Has Dowager Countess as 5th family member
- Cavendish: Starts at reputation level 1.4 (bonus reputation points)
- Ponsonby: Starts with £300 extra
- York: Starts with an extra Footman
- Wessex (expansion): Larger estate, choose Morning/Retiring or Breakfast/Tennis
- Howard (U/D expansion): Servant-focused, starts with extra Cook

TURN STRUCTURE:
Each player turn: 1) Choose an action: Host Activity, Hire Servant, Acquire Tile, Refresh Servants, Pass. 2) Take the action. 3) Play passes left.

HOST ACTIVITY: Choose a tile in your estate, ensure all required servants are available (in Servant Hall), assign them, invite guest(s) matching type requirements, gain the favors listed.

SPECIAL ROUNDS:
- Village Fair (round 3, 9 in standard / 4, 9, 16 extended): +£300 and +2 Rep for Private Study holders
- Courtship (round 4, 8, 12, 16 / 5, 10, 15, 20): VP scored by theme; winner gets Fairchild card
- Builder's Holiday (round 11 / 13): Buy unlimited tiles this round
- National Holiday (round 14 / 11): No reputation restrictions this round

GENTRY CARDS:
- Starter cards: free to invite, no reputation requirement
- Casual cards: require moderate reputation
- Prestige cards: require higher reputation
- Family cards: special family-specific guests
- Fairchild cards: won through Courtship

SCORING: Victory Points from tiles (face value), gentry cards held (VP printed), objective cards, prestige track position, money (£100 = 1 VP).

PASS ACTION: Take £50 and gain 1 reputation. Useful when you cannot afford other actions.

Answer questions based on this ruleset. Be specific about servant types, costs, and requirements. If something depends on expansion ownership, say so. For edge cases not explicitly covered, reason from the spirit of the rules.`;

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
    // Reject cross-origin browser calls from anywhere other than the allow-list.
    if (origin && !allowList.includes(origin)) {
      return json({ error: 'Origin not allowed' }, 403, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }, 500, cors);
    }

    // Optional per-IP rate limiting (enable the binding in wrangler.toml).
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
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    // Pass the Anthropic response straight through (the frontend reads `content[].text`).
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
