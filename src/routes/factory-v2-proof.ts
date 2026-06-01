import { Hono } from "hono";
import type { Env } from "../env";
import { generateStrategyContent } from "../lib/factory-v2/strategy-content-generator";
import { buildStrategyResultComposition } from "../lib/factory-v2/strategy-result-recipe";
import { assembleComposition } from "../lib/factory-v2/assemble";
import { wrapProofDocument } from "../lib/factory-v2/document-shell";

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY internal endpoint — factory-v2 step-3 clean-room proof.
//
// Runs the Parts 1-3 generator INSIDE the Worker (where ANTHROPIC_API_KEY is
// bound): LLM (Opus 4.8, streaming) returns CONTENT ONLY → Zod-validated →
// mapped onto the LOCKED Strategy result recipe → assembled 100% from the
// catalog (throws on unknown id) → wrapped in the shell + container frame.
// Returns the static HTML for capture into textos-web/public/dev/.
//
// Gated by INTERNAL_TRIGGER_SECRET (x-internal-secret header), same pattern as
// internal.ts. Not wired to any pipeline; safe to delete after the proof.
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const secret = c.req.header("x-internal-secret");
  if (!secret || secret !== c.env.INTERNAL_TRIGGER_SECRET) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    // 1. LLM → content only → Zod-validated (inside the Worker).
    const { content, meta } = await generateStrategyContent(c.env.ANTHROPIC_API_KEY);

    // 2. Map onto the locked recipe (LLM never chose components).
    const composition = buildStrategyResultComposition(content);

    // 3. Assemble 100% from the catalog (throws on any unknown id).
    const { html: inner, rendered_ids } = assembleComposition(composition);

    // 4. Wrap in shell + container frame.
    const doc = wrapProofDocument(inner);

    // Diagnostics in headers (short, channel-safe to read).
    const hay = JSON.stringify(content).toLowerCase();
    const specifics = {
      gluten: /gluten/.test(hay),
      staffed_station: /staffed|station|attendant/.test(hay),
      dec18: /(december|dec\.?)\s*18/.test(hay),
      guest_60_150: hay.includes("60") && hay.includes("150"),
      cajun: /cajun|louisiana|bayou/.test(hay),
    };

    return new Response(doc, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-fv2-composed-ids": rendered_ids.join(","),
        "x-fv2-sections": String(content.sections.length),
        "x-fv2-specifics": JSON.stringify(specifics),
        "x-fv2-stop-reason": String(meta.stop_reason),
        "x-fv2-output-tokens": String(meta.output_tokens),
      },
    });
  } catch (err) {
    return c.json(
      { error: "generation_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

export default app;
