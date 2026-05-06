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
  ENVIRONMENT: "dev" | "prod";
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
  /** KV namespace for anonymous snapshot tokens (C-Lite flow). */
  SNAPSHOT_KV: KVNamespace;
  /** Stripe secret key — set via `wrangler secret put STRIPE_SECRET_KEY`. */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret — set via `wrangler secret put STRIPE_WEBHOOK_SECRET`. */
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe price ID for Core Monthly ($29.99/mo). */
  STRIPE_PRICE_ID_CORE_MONTHLY: string;
  /** Stripe price ID for Founder Lifetime ($49.99 one-time). */
  STRIPE_PRICE_ID_FOUNDER_LIFETIME: string;
  /** Unsplash API access key — used to fetch hero images for public business sites. */
  UNSPLASH_ACCESS_KEY: string;
}
