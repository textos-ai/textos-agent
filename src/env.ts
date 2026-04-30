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
}
