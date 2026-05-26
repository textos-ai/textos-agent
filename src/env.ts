/**
 * Worker bindings + secrets.
 * Secrets are set via `wrangler secret put <NAME>` (see wrangler.toml notes).
 */
export interface Env {
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Supabase project JWT secret — used to verify `Authorization: Bearer <jwt>` headers. */
  SUPABASE_JWT_SECRET: string;
  /** Cloudflare API token with DNS:Edit on the textos.ai zone. */
  CLOUDFLARE_API_TOKEN: string;
  /** Zone ID of the textos.ai zone. */
  CLOUDFLARE_ZONE_ID: string;
  ENVIRONMENT: "dev" | "test" | "prod";
  /** Number of paying users required before cold emails auto-send (skipping admin approval). */
  AUTO_APPROVE_AFTER_USER_COUNT: string;
  /** Cloudflare account ID — used by the Pages deploy API. */
  CF_ACCOUNT_ID: string;
  /** fal.ai API key — used by hero image generation (flux-schnell). */
  FAL_API_KEY: string;
  /** Hunter.io API key — used for cold email prospect lookup. */
  HUNTER_API_KEY: string;
  /** SendGrid API key — used for outbound email dispatch. */
  SENDGRID_API_KEY: string;
  /** Google Places API key — used by DayCycle location lookups. */
  GOOGLE_PLACES_API_KEY: string;
  /** Feature flag: enable Google Places API calls in daycycle-connect. */
  DAYCYCLE_PLACES_ENABLED: string;
  /** Base URL of the frontend that should receive Stripe success/cancel redirects.
   *  Set per-environment in wrangler.toml [vars]. Falls back to "https://app.textos.ai"
   *  for safety if unset. Examples:
   *    prod (textos-agent-dev): https://app.textos.ai
   *    test (textos-agent-test): https://textos-web-test.pages.dev          */
  FRONTEND_URL?: string;
  /** KV namespace for anonymous snapshot tokens (C-Lite flow). */
  SNAPSHOT_KV: KVNamespace;
  /** Alpha-only rate limit bypass. Set to 'true' via wrangler secret put LETMEIN_BYPASS_ENABLED.
   *  Leave unset (or 'false') in production — bypass is inert when this var is absent. */
  LETMEIN_BYPASS_ENABLED?: string;
  /** Stripe secret key — set via `wrangler secret put STRIPE_SECRET_KEY`. */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret — set via `wrangler secret put STRIPE_WEBHOOK_SECRET`. */
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe price ID for Core Monthly ($29.99/mo). */
  STRIPE_PRICE_ID_CORE_MONTHLY: string;
  /** Stripe price ID for Founder Lifetime ($49.99 one-time). */
  STRIPE_PRICE_ID_FOUNDER_LIFETIME: string;
  /** Stripe price ID for Standard Monthly subscription ($49.99/mo, 3-day trial). */
  STRIPE_PRICE_STANDARD_MONTHLY: string;
  /** Stripe price ID for Top-up bundle: 10 tokens for $9.99 (one-time). */
  STRIPE_PRICE_TOPUP_10: string;
  /** Stripe price ID for Top-up bundle: 30 tokens for $24.99 (one-time). */
  STRIPE_PRICE_TOPUP_30: string;
  /** Stripe price ID for Top-up bundle: 75 tokens for $49.99 (one-time). */
  STRIPE_PRICE_TOPUP_75: string;
  /** Unsplash API access key — used to fetch hero images for public business sites. */
  UNSPLASH_ACCESS_KEY: string;
  /** R2 bucket for generated assets (logos, hero images, exports). */
  ASSETS: R2Bucket;
  /** Shared secret for internal worker→worker calls (chain-pattern task triggers).
   *  Set via `wrangler secret put INTERNAL_TRIGGER_SECRET --env <env>`.
   *  Validated in /api/internal/run-task via the `x-internal-secret` header.
   *  Required by generate-business-app-design to dispatch the HTML step. */
  INTERNAL_TRIGGER_SECRET?: string;
  /** Optional override for this Worker's own public URL — used by task handlers
   *  that need to self-call (e.g. chain pattern). If unset, derived from
   *  ENVIRONMENT. Set via wrangler.toml [env.test.vars] for cleanliness. */
  AGENT_URL?: string;
  /** Service Binding pointing at this same Worker. Used by chain-pattern task
   *  handlers (generate-business-app-design → generate-business-app-html) to
   *  fire a self-invocation without hitting Cloudflare's same-Worker public
   *  URL block (CF error 1042). Routed by binding, not DNS — Request URL
   *  hostname is ignored. Declared in wrangler.toml as [[services]] (prod)
   *  and [[env.test.services]] (test).
   *
   *  Kept alive as a fallback after the APP_GEN_HTML_QUEUE rollout — Design
   *  handler prefers the queue path when its binding is present, falls back
   *  to env.SELF.fetch when the queue binding is undefined. */
  SELF: Fetcher;
  /** Cloudflare Queue producer for the generate-business-app HTML step.
   *  Optional during the soak period — the Design handler falls back to the
   *  SELF service-binding chain when undefined. Declared in wrangler.toml as
   *  [[queues.producers]] (prod) and [[env.test.queues.producers]] (test);
   *  the matching consumer handler lives in src/queues/app-gen-html-consumer.ts.
   *  See src/queues/types.ts for the message shape. */
  APP_GEN_HTML_QUEUE?: Queue<import("./queues/types").HtmlJobMessage>;
}
