// Business media — upload, list, update, delete.
//
// Storage is R2 via the existing `ASSETS` binding (bucket `textos-assets`),
// served publicly from assets.victora.ai. Same destination src/lib/tasks/logo.ts
// already writes to; no new provider was introduced. When AI generation lands it
// writes to the same bucket with origin='generated' — nothing here needs to
// change for that.
//
// Rows are BUSINESS-scoped (site_id nullable), per the 091 decision: a logo is a
// business fact and must exist before any site does.
//
// ALT TEXT IS REQUIRED on every upload, image or video. It is not a nicety —
// without it the image is invisible to a screen reader and to a crawler, and a
// readiness rule will check for it. Video additionally requires a poster frame.
//
// Intrinsic width/height/bytes are recorded at upload from the file itself for
// images (image-dims.ts). Video dimensions come from the client (<video>
// element) because MP4 atom walking is out of proportion here; they are
// validated as plausible integers rather than trusted blindly.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { requireAuth } from "../lib/jwt";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { imageDimensions, ALLOWED_IMAGE, ALLOWED_VIDEO, extensionFor } from "../lib/site-render/image-dims";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

const MEDIA_HOST = "https://assets.victora.ai";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // 12 MB
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;   // 80 MB — hero background, not a film

const ROLES = ["logo", "hero", "gallery", "og", "background"] as const;

// ── GET /:slug/media ──────────────────────────────────────────────────────
app.get("/:slug/media", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const role = c.req.query("role");
  let q = supabase
    .from("site_media")
    .select("id, url, alt_text, mime_type, width, height, bytes, kind, role, origin, poster_url, created_at")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false });
  if (role) q = q.eq("role", role);

  const { data, error } = await q;
  if (error) {
    log.error("[media] list_failed", { business_id: business.id, err: error.message });
    return c.json(errBody("internal", `media_list_failed: ${error.message}`), 500);
  }
  return c.json({ media: data ?? [] });
});

// ── POST /:slug/media ─────────────────────────────────────────────────────
// multipart/form-data: file, alt_text (required), role?, kind?, width?, height?,
// poster_url? (required for video)
app.post("/:slug/media", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  if (!c.env.ASSETS) {
    // No silent fallback to a third-party CDN URL — that would produce a
    // media row pointing at storage we do not control.
    return c.json(errBody("not_configured", "R2 ASSETS binding is not bound to this Worker"), 503);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(errBody("bad_request", "expected multipart/form-data"), 400);
  }

  // Structural check rather than `instanceof File` — the Workers runtime types
  // do not expose a `File` constructor value, so instanceof does not compile.
  const fileRaw = form.get("file") as unknown;
  const file = fileRaw as { name?: string; type?: string; size?: number; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (!file || typeof file.arrayBuffer !== "function" || typeof file.size !== "number") {
    return c.json(errBody("bad_request", "field 'file' is required and must be a file upload"), 400);
  }

  // ALT TEXT — required, no default, no derivation from the filename.
  const altText = String(form.get("alt_text") ?? "").trim();
  if (altText === "") {
    return c.json(
      errBody("bad_request", "alt_text is required", [
        { field: "alt_text", message: "Describe the image for screen readers and search engines. Required on every upload." },
      ]),
      400,
    );
  }

  const mime = file.type || "application/octet-stream";
  const isVideo = ALLOWED_VIDEO.has(mime);
  const isImage = ALLOWED_IMAGE.has(mime);
  if (!isImage && !isVideo) {
    return c.json(
      errBody("bad_request", `unsupported file type '${mime}'`, [
        { field: "file", message: `Allowed: ${[...ALLOWED_IMAGE, ...ALLOWED_VIDEO].join(", ")}` },
      ]),
      400,
    );
  }

  const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) {
    return c.json(
      errBody("bad_request", "file too large", [
        { field: "file", message: `${(file.size / 1048576).toFixed(1)} MB exceeds the ${(limit / 1048576) | 0} MB limit for ${isVideo ? "video" : "images"}.` },
      ]),
      400,
    );
  }

  const roleRaw = String(form.get("role") ?? "").trim();
  const role = roleRaw === "" ? null : roleRaw;
  if (role && !ROLES.includes(role as (typeof ROLES)[number])) {
    return c.json(errBody("bad_request", `role must be one of ${ROLES.join(", ")}`), 400);
  }

  const posterUrl = String(form.get("poster_url") ?? "").trim() || null;
  if (isVideo && !posterUrl) {
    return c.json(
      errBody("bad_request", "poster_url is required for video", [
        { field: "poster_url", message: "Upload a poster frame first — without it there is nothing to show before the video decodes, or at all if autoplay is blocked." },
      ]),
      400,
    );
  }

  const bytes = await file.arrayBuffer();

  // Dimensions: parsed from the file for images, client-supplied for video.
  let width: number | null = null;
  let height: number | null = null;
  if (isImage) {
    const d = imageDimensions(bytes);
    if (d) { width = d.width; height = d.height; }
  }
  if (width === null) {
    const cw = Number(form.get("width"));
    const ch = Number(form.get("height"));
    if (Number.isInteger(cw) && Number.isInteger(ch) && cw > 0 && ch > 0 && cw < 20000 && ch < 20000) {
      width = cw; height = ch;
    }
  }

  // Key: business-scoped, collision-proof, extension preserved so the R2 custom
  // domain serves a sane Content-Type even without metadata.
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `businesses/${business.id}/media/${stamp}-${rand}.${extensionFor(mime)}`;

  try {
    await c.env.ASSETS.put(key, bytes, {
      httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: {
        business_id: business.id,
        uploaded_by: auth.user_id,
        uploaded_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    log.error("[media] r2_put_failed", { business_id: business.id, key, err: String(err) });
    return c.json(errBody("internal", `r2_upload_failed: ${String(err)}`), 500);
  }

  const url = `${MEDIA_HOST}/${key}`;
  const { data, error } = await supabase
    .from("site_media")
    .insert({
      business_id: business.id,
      site_id: null,
      url,
      r2_key: key,
      alt_text: altText,
      mime_type: mime,
      width, height,
      bytes: file.size,
      kind: isVideo ? "video" : "image",
      role,
      origin: "uploaded",
      poster_url: posterUrl,
      source: "operator",
      updated_by: auth.user_id,
    })
    .select("id, url, alt_text, mime_type, width, height, bytes, kind, role, origin, poster_url, created_at")
    .single();

  if (error) {
    // The object is in R2 but the row failed. Remove the orphan so the bucket
    // does not accumulate unreferenced blobs.
    // Deliberate: this runs while already handling a failure. A cleanup error must
    // not replace the original one, which is the error worth reporting.
    await c.env.ASSETS.delete(key).catch(() => {});
    log.error("[media] row_insert_failed", { business_id: business.id, key, err: error.message });
    return c.json(errBody("internal", `media_row_failed: ${error.message}`), 500);
  }

  log.info("[media] uploaded", { business_id: business.id, key, kind: isVideo ? "video" : "image", role, bytes: file.size });
  return c.json({ ok: true, media: data });
});

// ── PATCH /:slug/media/:id ────────────────────────────────────────────────
// Edit alt text or role. Alt text can be changed but never blanked.
const PatchBody = z.object({
  alt_text: z.string().trim().min(1, "alt_text cannot be blank").optional(),
  role: z.enum(ROLES).nullable().optional(),
});

app.patch("/:slug/media/:id", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  let patch: z.infer<typeof PatchBody>;
  try {
    patch = PatchBody.parse(await c.req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(errBody("bad_request", "invalid", err.issues.map((i) => ({ field: i.path.join("."), message: i.message }))), 400);
    }
    return c.json(errBody("bad_request", "body must be valid JSON"), 400);
  }

  const { data, error } = await supabase
    .from("site_media")
    .update({ ...patch, updated_by: auth.user_id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("business_id", business.id)
    .select("id, url, alt_text, role, kind")
    .maybeSingle();

  if (error) return c.json(errBody("internal", `media_update_failed: ${error.message}`), 500);
  if (!data) return c.json(errBody("not_found", "media not found for this business"), 404);
  return c.json({ ok: true, media: data });
});

// ── DELETE /:slug/media/:id ───────────────────────────────────────────────
app.delete("/:slug/media/:id", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const { data: row } = await supabase
    .from("site_media")
    .select("id, r2_key")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (!row) return c.json(errBody("not_found", "media not found for this business"), 404);

  // business_profile.logo_media_id / hero_media_id and business_projects.media_id
  // are ON DELETE SET NULL, so the references clear themselves.
  const { error } = await supabase.from("site_media").delete().eq("id", id).eq("business_id", business.id);
  if (error) return c.json(errBody("internal", `media_delete_failed: ${error.message}`), 500);

  const key = (row as { r2_key: string | null }).r2_key;
  if (key && c.env.ASSETS) await c.env.ASSETS.delete(key).catch((e) => {
    log.warn("[media] r2_delete_failed", { key, err: String(e) });
  });

  return c.json({ ok: true });
});

export default app;
