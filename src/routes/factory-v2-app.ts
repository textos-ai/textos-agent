import { Hono } from "hono";
import type { Env } from "../env";
import { generateStrategyContentFromAnswers } from "../lib/factory-v2/strategy-live-generator";
import { SAMPLE_BUSINESS } from "../lib/factory-v2/strategy-live-prompt";
import { buildStrategyResultComposition } from "../lib/factory-v2/strategy-result-recipe";
import { assembleComposition } from "../lib/factory-v2/assemble";
import { wrapProofDocument } from "../lib/factory-v2/document-shell";
import { buildStrategyCollectPage } from "../lib/factory-v2/strategy-collect-recipe";
import { pickStableSkin, isFactoryV2Skin } from "../lib/factory-v2/strategy-skin";

// ─────────────────────────────────────────────────────────────────────────────
// TEMP DEV — factory-v2 Step-4 wizard app (retire at cutover, same as the
// factory-v2-proof endpoint). Browser-callable and NOT secret-gated: it must
// accept an anonymous visitor POST. Keep it a /dev/ route, not a permanent
// public endpoint.
//
//   GET  /  → the themed COLLECT wizard page (Homer skin + light), composed
//             100% from the catalog (hero[light] + wizard + inputs). On submit
//             its JS POSTs the visitor's REAL answers back here.
//   POST /  → { answers:[{question,answer}] } → the PROVEN chain (LLM content
//             only → Zod → locked recipe → assembler, throw-on-unknown active)
//             → returns the composed RESULT inner HTML (its own hero[light] →
//             card-basic ×N → list-group → card-cta → share-bar → download).
//
// Assets: a page served from the Worker origin has no /homer/* of its own, so
// it loads the Homer bundle from the textos-web TEST origin (which does).
// ─────────────────────────────────────────────────────────────────────────────

const HOMER_ASSET_BASE = "https://textos-web-test.pages.dev";

const app = new Hono<{ Bindings: Env }>();

// GET — serve the themed wizard page.
app.get("/", (c) => {
  const override = c.req.query("skin");
  const skin = isFactoryV2Skin(override) ? override : pickStableSkin(SAMPLE_BUSINESS.name);

  const { innerHtml, inlineScript } = buildStrategyCollectPage();
  const doc = wrapProofDocument(innerHtml, {
    skin,
    assetBase: HOMER_ASSET_BASE,
    extraScripts: ["/homer/js/pages/form-wizard.js"], // wizard init (not in app.mini.js)
    inlineScript,
  });

  return c.html(doc, 200, { "x-fv2-skin": skin });
});

// POST — visitor's real answers → proven generate chain → result inner HTML.
app.post("/", async (c) => {
  let body: { answers?: { question: string; answer: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const answers = body?.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    return c.json({ error: "no_answers" }, 400);
  }

  try {
    // PROVEN chain — visitor's REAL answers this time (not the hardcoded sample).
    const { content, meta } = await generateStrategyContentFromAnswers(
      c.env.ANTHROPIC_API_KEY,
      SAMPLE_BUSINESS,
      answers,
    );
    const composition = buildStrategyResultComposition(content);
    const { html: inner, rendered_ids } = assembleComposition(composition); // throws on unknown id

    const hay = JSON.stringify(content).toLowerCase();
    const specifics = {
      gluten: /gluten/.test(hay),
      staffed_station: /staffed|station|attendant/.test(hay),
      dec18: /(december|dec\.?)\s*18/.test(hay),
      guest_60_150: hay.includes("60") && hay.includes("150"),
      cajun: /cajun|louisiana|bayou/.test(hay),
    };

    return c.html(inner, 200, {
      "x-fv2-composed-ids": rendered_ids.join(","),
      "x-fv2-sections": String(content.sections.length),
      "x-fv2-specifics": JSON.stringify(specifics),
      "x-fv2-stop-reason": String(meta.stop_reason),
      "x-fv2-output-tokens": String(meta.output_tokens),
    });
  } catch (err) {
    return c.json(
      { error: "generation_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

export default app;
