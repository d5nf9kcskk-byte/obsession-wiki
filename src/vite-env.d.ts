/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of the Cloudflare Worker that proxies requests to the Anthropic API. */
  readonly VITE_AI_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
