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
}
