import type { Env } from "../env";

interface CfApiResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/**
 * Create a CNAME record in the Cloudflare zone identified by
 * `env.CLOUDFLARE_ZONE_ID`. `name` is relative to the zone root —
 * e.g., for record `rob.app.textos.ai` in zone `textos.ai`, pass
 * `name = "rob.app"`. Throws on API failure.
 *
 * Cloudflare error code 81053 ("record already exists") is surfaced
 * as a tagged error so callers can decide whether to ignore it.
 */
export async function createCnameRecord(
  env: Env,
  name: string,
  target: string,
  comment = "TextOS handle subdomain",
): Promise<DnsRecord> {
  const url = `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "CNAME",
      name,
      content: target,
      proxied: true,
      ttl: 1, // automatic
      comment,
    }),
  });

  const data = (await res.json()) as CfApiResponse<DnsRecord>;

  if (!res.ok || !data.success) {
    const detail =
      data.errors
        ?.map((e) => `${e.code}: ${e.message}`)
        .join("; ") ?? `HTTP ${res.status}`;
    const alreadyExists = data.errors?.some((e) => e.code === 81053);
    const err = new Error(detail) as Error & { alreadyExists?: boolean };
    if (alreadyExists) err.alreadyExists = true;
    throw err;
  }

  return data.result!;
}
