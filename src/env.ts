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
}
