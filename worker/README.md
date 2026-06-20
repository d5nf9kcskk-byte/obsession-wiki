# Obsession AI Proxy (Cloudflare Worker)

This Worker keeps the Anthropic API key **off the public frontend**. The wiki's
"Ask the Rulebook" chat POSTs a conversation to this Worker, which adds the key,
model, system prompt, and token cap, then forwards the request to Anthropic.

Because the model, system prompt, and `max_tokens` are fixed in
[`src/index.ts`](src/index.ts) (not sent by the browser), the proxy can only be
used to ask Obsession rulebook questions — it is not a general-purpose Claude
endpoint.

## How the AI knows the rules

The worker feeds the model the **complete Obsession reference** — every rule,
tile, gentry card, servant, family, component list, and FAQ entry. That reference
is compiled from the same data that powers the wiki by
[`scripts/build-knowledge.ts`](../scripts/build-knowledge.ts) into
`ai-knowledge.txt`, which the site serves at
`<site>/ai-knowledge.txt`.

The worker **fetches that file at runtime** (cached up to 1 hour) and uses it as
the system prompt, with instructions to answer directly and never tell the user
to "go read the rulebook." Because the file is regenerated on every site build,
**the AI's knowledge updates automatically whenever the wiki content changes** —
you do not need to redeploy the worker to update its knowledge.

> If you change the worker code itself (this file's logic), you do need to
> redeploy/re-paste it once. Updating wiki *content* requires only a site rebuild.

## One-time setup

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and an
[Anthropic API key](https://console.anthropic.com) (with a little billing credit).

```bash
cd worker
npm install

# Log in to Cloudflare (opens a browser)
npx wrangler login

# Store your Anthropic key as an encrypted secret (you'll be prompted to paste it)
npx wrangler secret put ANTHROPIC_API_KEY

# Deploy
npm run deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://obsession-ai-proxy.<your-subdomain>.workers.dev`. Copy it.

## Wire the frontend to the Worker

The frontend reads the Worker URL from the `VITE_AI_PROXY_URL` build-time
variable.

**For the deployed site (GitHub Pages):** add a repository **variable** (not a
secret — the URL is public anyway) named `VITE_AI_PROXY_URL`:

> GitHub repo → Settings → Secrets and variables → Actions → **Variables** tab →
> New repository variable → `VITE_AI_PROXY_URL` = your Worker URL

Then re-run the **Deploy Obsession Wiki** workflow (the build step passes this
through automatically). Until it is set, the chat shows an "AI assistant not
configured" notice instead of erroring.

**For local development:** copy `.env.example` to `.env` in the repo root and set
`VITE_AI_PROXY_URL`. Also add `http://localhost:5174` to `ALLOWED_ORIGIN` in
[`wrangler.toml`](wrangler.toml) so the Worker's CORS check accepts your dev origin.

## Configuration

- **`ALLOWED_ORIGIN`** (in `wrangler.toml`): comma-separated list of browser
  origins allowed to call the Worker. Defaults to the GitHub Pages origin.
- **`KNOWLEDGE_URL`** (in `wrangler.toml`): URL of the compiled reference the AI
  reads. Defaults to `<site>/ai-knowledge.txt`; only change it if your wiki is
  hosted somewhere else.
- **Rate limiting** (optional): uncomment the `RATE_LIMITER` binding in
  `wrangler.toml` to enable per-IP limiting, then redeploy.

> Note: CORS restricts *browsers* to your origin but cannot stop a determined
> caller using `curl`. The fixed system prompt + small `max_tokens` keep abuse
> cheap and on-topic; enable the rate limiter (and/or Cloudflare WAF rules) if
> you want stronger protection.
