# TextOS Component Factory — PRD

**Version:** Draft 1
**Date:** May 25, 2026
**Author:** Rob Gaudet (architect) + Claude
**Status:** Pre-implementation review

---

## 1. Why this exists

TextOS generates AI-powered mini-apps for operators. Today, every app is hand-written HTML/CSS/JS by an LLM at generation time. This is the wrong layer of abstraction. It costs too many tokens, takes too long, produces inconsistent quality, and gives operators no safe way to customize the result.

The Component Factory replaces raw HTML generation with **composition from a curated component library**. The LLM picks pre-built, battle-tested components and configures them. The platform stitches them together. Operators can customize within guardrails.

**The shift:** from "generate an app" to "compose an app."

---

## 2. The problem in concrete terms

**Today's generation pipeline:**
- LLM generates 8000+ tokens of raw HTML on every app build
- 40-90 second generation times even with Cloudflare Queues
- Quality varies dramatically run to run — same business + same tier = different UX
- 30KB+ of inline CSS/JS per app, regenerated every time
- Operators have only two states: accept what was generated, or regenerate and pray
- No path to "make this match my brand" without losing the working app

**What operators actually need:**
- Apps that look professional out of the box, every time
- Confidence the generation will produce something usable
- The ability to adjust styling without breaking functionality
- Apps that feel like their brand, not TextOS-generic
- Fast generation so they can iterate

**What the platform needs:**
- Predictable token costs
- Consistent visual identity across generated apps (protects brand)
- A foundation for adding new app types without rebuilding the prompt
- Edit primitives that can become a monetization lever later

---

## 3. The solution in one paragraph

We license Homer (a comprehensive Bootstrap 5 admin template with 95+ pages, every common UI control, charts, forms, calendars, data tables, etc.). We catalog its components in a Supabase table. We host its CSS/JS bundle on R2 served from `apps.textos.ai`. The LLM's job becomes choosing components and supplying data, not writing HTML. A template engine assembles the final app from the composition spec. Operators get a tiered edit system — style edits free, layout edits and full edits paid — built on top of the same component structure.

---

## 4. Architecture

### 4.1 Asset layer (R2)

Single shared Homer bundle uploaded once to R2, served via Cloudflare CDN:

```
apps.textos.ai/homer/
  css/
    style.css           ← Bootstrap 5 + Homer custom styles
    themes/             ← Pre-built theme variants
  js/
    script.js           ← Core Homer JS
  vendor/
    chart.js/
    flatpickr/
    choices.js/
    dropzone/
    swiper/
    tabler-icons/
    [etc.]
```

Every generated app references these via `<link>` and `<script>` tags. Cloudflare's edge cache serves them globally with sub-100ms delivery after the first request. After a visitor's first TextOS app, every subsequent app loads instantly because the bundle is already in their browser cache.

**Why R2:** TextOS already uses R2 for asset storage. No new infrastructure. Free egress to Cloudflare's CDN. Bundle updates are a single upload.

### 4.2 Component catalog (Supabase)

New table `app_components`:

```sql
CREATE TABLE public.app_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,             -- e.g. 'hero-with-cta', 'quiz-stepper'
  name          text NOT NULL,                    -- human-readable
  category      text NOT NULL,                    -- 'hero', 'form', 'result', 'navigation', etc.
  use_cases     text[] NOT NULL DEFAULT '{}',     -- ['quiz', 'calculator', 'recommender']
  description   text NOT NULL,                    -- what it does, when to use it
  html_template text NOT NULL,                    -- Mustache/Handlebars template
  required_js   text[] NOT NULL DEFAULT '{}',     -- ['chart.js', 'choices.js']
  config_schema jsonb NOT NULL DEFAULT '{}'::jsonb, -- JSON Schema for the component's data
  preview_url   text,                             -- optional reference render
  status        text NOT NULL DEFAULT 'active',   -- 'active', 'deprecated', 'draft'
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_components_category ON app_components(category);
CREATE INDEX idx_app_components_use_cases ON app_components USING GIN(use_cases);
CREATE INDEX idx_app_components_status ON app_components(status);
```

The LLM has read access to this catalog when generating. It picks components by slug; the template engine looks up the HTML template and renders it with the LLM-supplied data.

### 4.3 Generation pipeline (modified)

**Design step (unchanged conceptually, output format changes):**
- Input: business context + operator's app description + tier
- Output: composition spec — JSON document describing the app

**New composition spec format:**

```json
{
  "app_type": "recommendation_engine",
  "app_title": "Your Perfect Charcuterie Match",
  "app_tagline": "Discover the artisan board crafted just for you",
  "theme": {
    "primary_color": "#8B4513",
    "accent_color": "#D4A574",
    "font_family": "elegant"
  },
  "composition": [
    {
      "component_slug": "hero-with-intro",
      "data": {
        "headline": "Your Perfect Charcuterie Match",
        "subheadline": "Discover the artisan board crafted just for you",
        "intro_text": "Tell us about your event..."
      }
    },
    {
      "component_slug": "quiz-stepper",
      "data": {
        "questions": [...]
      }
    },
    {
      "component_slug": "result-card-detailed",
      "data": {
        "title_template": "Your Recommended Board: {recommendation}",
        "logic": "..."
      }
    },
    {
      "component_slug": "cta-block-conversion",
      "data": {
        "headline": "Ready to order?",
        "primary_cta": "Get My Quote",
        "secondary_cta": "Save My Results"
      }
    }
  ],
  "behaviors": {
    "save_enabled": true,
    "download_enabled": true,
    "email_capture": true
  }
}
```

**HTML assembly step (replaces today's "generate HTML" step):**
- Looks up each component in `app_components` by slug
- Renders the template with the data
- Stitches the result into the final HTML document
- Injects standard TextOS app shell (TXAPP global, analytics, save/download buttons)
- Sanitizes the output (security pass)
- Stores in `business_assets`

This step is **deterministic and fast** — it's a database lookup + template render, not an LLM call. Generation time drops dramatically because only the design step requires the LLM.

**Optional refinement step (LLM):**
- For custom JS logic that components can't express (complex recommendation algorithms, multi-field calculations), the LLM generates a small JS snippet that gets injected into the assembled app
- Token cost: ~500-1500 tokens vs. today's 8000

### 4.4 Token economy impact

| | Today | With Factory |
|---|---|---|
| Design step tokens | ~1500 | ~2000 (slightly more — composition spec is structured) |
| HTML step tokens | ~8000 | 0 (template assembly, no LLM) |
| Optional refinement | n/a | ~500-1500 |
| Total LLM tokens | ~9500 | ~2500-3500 |
| Generation time | 40-90s | 8-20s |

**Operator-facing token cost recommendation:**
- Haiku: 2 → 1 token
- Sonnet: 5 → 3 tokens
- Opus: 10 → 6 tokens

Cheaper per generation makes "generate multiple apps" feel free, which it effectively is.

---

## 5. Component catalog — MVP scope

**15 components to cover the three app patterns we've already seen** (quiz, calculator, recommender):

### Layout / structure
1. `hero-with-intro` — Title, subtitle, intro paragraph, optional image
2. `progress-bar-stepper` — Visual progress indicator (e.g. "Question 3 of 8")
3. `result-section-divider` — Visual break between input and result

### Forms / input
4. `quiz-stepper` — Multi-step question form with prev/next navigation
5. `single-choice-question` — Radio buttons with descriptions
6. `multi-choice-question` — Checkboxes with descriptions
7. `text-input-question` — Single-line or textarea
8. `scale-question` — 1-10 slider or numbered buttons
9. `number-input-with-unit` — Number input with unit label (guests, dollars, etc.)

### Result / display
10. `result-card-detailed` — Headline result + structured detail sections
11. `result-card-with-image` — Result with hero image (uses fal.ai gen)
12. `pricing-tier-display` — Three-tier pricing comparison
13. `recommendation-list` — Ranked list of recommendations with reasoning

### Action / conversion
14. `cta-block-conversion` — Primary + secondary CTA with explanation
15. `save-download-row` — Save / Download / Email actions

Each component:
- Mobile-first responsive
- Uses Homer's design system out of the box
- Accepts theme variables for operator-brand customization
- Includes ARIA labels and accessible markup
- Renders identically across browsers (Bootstrap handles this)

### Expansion (V1.1+)
Calendars, file uploads, charts, comparison tables, FAQ accordions, testimonials, image galleries, video embeds, maps, data tables. The catalog can grow to 100+ components without architectural changes.

---

## 6. Quality guidelines (enforced by component templates, not prompts)

The component templates encode TextOS's app quality standards. Every generated app gets these for free because they're baked into the components:

**Universal requirements built into every relevant component:**

- **Strong CTA at every result.** `result-card-*` components include a built-in CTA section. `cta-block-conversion` is required at the end of every flow.
- **Save / Download / Email actions.** `save-download-row` component appears on every result page. Captures lead info, generates PDF, emails to visitor.
- **Mobile-first layout.** All components designed mobile-first, breakpoints handled by Bootstrap.
- **Loading states.** Components include skeleton loaders for any async operation.
- **Empty states.** Components handle "no data" gracefully.
- **Brand-consistent imagery.** `result-card-with-image` integrates with fal.ai for AI-generated hero images matching the result.
- **Clear visual hierarchy.** Typography scale defined in Homer's CSS, components use it consistently.
- **Touch targets ≥44px.** Bootstrap defaults already meet this.
- **Accessible markup.** ARIA labels, semantic HTML, focus states built into every component.

**Operators can't break these** because they're in the component, not the generation. The only way to lose them is to leave the catalog entirely (which only the full-edit tier allows).

---

## 7. Tiered edit system

Three tiers of operator customization, each with implicit guarantees about what stays working:

### Tier 1: Style edits (free, with usage cap)

**What it changes:** Theme variables — colors, fonts, spacing, button shapes, border radii.

**Mechanism:** UI surfaces a small palette of editable CSS variables. Operator picks colors, fonts, etc. Changes write to the asset's `theme` block. No HTML is touched.

**What's guaranteed:** App continues to work. Forms submit. Result logic fires. Paywall functions.

**Pricing:** 3 free style edits per app. Additional edits at 1 TextOS token each, or unlock unlimited via Premium subscription.

**Implementation effort:** Small. Operator UI is a form with color pickers and font selectors.

### Tier 2: Layout edits (paid)

**What it changes:** Component arrangement (reorder, add, remove), component swapping (replace one component slug with another of the same category), and content edits (text labels, headlines, CTAs).

**Mechanism:** Operator UI shows the composition as a vertical list of cards. Drag to reorder. "Swap" button shows other components in the same category. "Edit content" opens the data fields. Saves back to the composition spec; HTML reassembles.

**What's guaranteed:** Form fields still work, paywall integration still works, TXAPP global still works. Operator can rearrange but can't touch the underlying logic.

**Pricing:** 1 TextOS token per layout edit, or unlocked via Premium subscription. AI-assisted version ("operator, swap the result card for the pricing table") costs 2 tokens.

**Implementation effort:** Medium. UI is more complex (drag-drop, component swap modal).

### Tier 3: Full edit (paid, advanced)

**What it changes:** Anything. Direct HTML/CSS/JS editing on the assembled app.

**Mechanism:** Code editor surface (Monaco or similar). Operator edits the raw asset HTML. Versioning enabled by default — every save is a new version, revertible.

**What's guaranteed:** Nothing. The operator owns the risk.

**Pricing:** Premium+ tier only, or unlocked via add-on subscription. Maybe one-time unlock fee per app.

**Implementation effort:** Large. Code editor integration, versioning UI, preview pane, safety warnings.

### What ships in V1 of the factory

Tier 1 (style edits) only. Tiers 2 and 3 are V1.1 and V1.2 work.

---

## 8. AI selection of components

The LLM's design step is modified to output a composition spec. The prompt provides the catalog as context:

**Prompt structure (Design step):**

```
You are designing a mini-app for {business_name}.

The business: {business_context}
Operator's app description: {operator_description}
LLM tier: {tier}

Available components in the catalog:
{components_list_with_descriptions}

Your task: Output a composition spec — a JSON document selecting the right components 
for this app and providing the data each component needs.

Required components by app type:
- Quiz / recommender: hero-with-intro, progress-bar-stepper, [N question components], 
  result-card-detailed, cta-block-conversion, save-download-row
- Calculator: hero-with-intro, [input components], result-card-detailed, 
  cta-block-conversion, save-download-row
- Lead form: hero-with-intro, [form components], cta-block-conversion

Tone, content, and the specific component sequence is your choice. Match the business.

Output the composition spec as JSON only.
```

The component catalog injected into the prompt is small (~1000 tokens for 15 components). The LLM's output is the composition spec (~1500-2000 tokens). Total Design step: ~2000 tokens, same range as today but producing structured output that drives deterministic assembly.

**Why this works:** The LLM is good at structured selection and content generation. It's wasteful at writing CSS, generating Bootstrap class names, and reimplementing form validation. We let it do what it's good at.

---

## 9. Data model changes

**New tables:**
- `app_components` (catalog, defined in §4.2)
- `app_edits` (audit log of operator customizations, for the tiered edit system)

**Modified tables:**
- `business_assets.asset_data` jsonb gains: `composition_spec`, `theme`, `component_version_lock`
- `business_assets` gains a versioning column for edit history
- `app_configs` adds `edit_tier_unlocked` enum: `style`, `layout`, `full`

**Migration path:**
- Existing generated apps (raw HTML) keep working — the `business_assets.asset_data.html` field is read first
- New apps use `composition_spec` + on-the-fly assembly
- Old apps can be opted into the new model by triggering a regeneration

---

## 10. Multi-app support (prerequisite)

The component factory assumes operators can have multiple apps per business. The current schema implicitly enforces one-app-per-business. This must be fixed before or during factory rollout — already noted as tomorrow's first task in the project backlog.

**Required changes:**
- Drop the implicit singleton constraint on `business_assets` for `asset_type='app'`
- Apps get individual slugs: `/sites/{slug}/apps/{app-slug}` instead of `/sites/{slug}/app`
- Operator UI shows a grid of apps with "Create New" button
- Public site teaser handles multiple apps (featured + list, or grid)
- Soft cap: 10 active apps per business in V1, configurable

---

## 11. Observability & telemetry

**Per-generation logging (extends current `stream_events` infrastructure):**
- `factory_component_selected` — which components the LLM picked for this app
- `factory_composition_spec_complete` — full spec with token counts
- `factory_assembly_start` / `factory_assembly_complete` — template render timing
- `factory_assembly_failed` — when a component lookup fails or template renders empty

**Per-app metrics (visible to operator):**
- Total visits to the app
- Form completions
- CTA clicks
- Lead captures (email + download requests)
- Average time on app

**Per-component metrics (admin view, for catalog improvement):**
- Usage frequency by component slug
- Time spent in each component (engagement)
- Components that correlate with form abandonment
- Components that correlate with CTA conversion

This lets us iterate the catalog based on real data, not opinion.

---

## 12. Implementation phases

### Phase 0: License and asset setup (1-2 days)
- Email Homer support, confirm Extended License covers the SaaS-generation use case
- Purchase Extended License ($799 one-time)
- Upload Homer assets to R2 at `apps.textos.ai/homer/`
- Configure Cloudflare cache headers for long-lived static assets
- Verify cross-origin loading from generated app iframes works

### Phase 1: Multi-app support (1 day)
- Schema migration (drop singleton, add app slugs)
- Operator UI grid view at `/business/{slug}/apps`
- Public site routing for `/sites/{slug}/apps/{app-slug}`
- Backward-compat redirect from singleton URL to most recent app

### Phase 2: Component catalog v1 (2-3 days)
- Schema migration for `app_components` table
- Build the 15 MVP components (HTML templates, config schemas)
- Component preview page (admin tool to see each component rendered)
- Seed the database with the 15 components

### Phase 3: Generation pipeline rewrite (2-3 days)
- New Design step prompt that outputs composition specs
- New assembly step (deterministic template render, no LLM)
- Migration of token cost economics (lower costs reflecting reduced LLM usage)
- New logging events
- Keep raw-HTML generation path as fallback during transition

### Phase 4: Style edit UI (2 days)
- Operator UI for theme customization (colors, fonts)
- 3-free-edits-then-paid token mechanic
- Theme variables wired through to component templates

### Phase 5: Test, measure, iterate (1 week)
- Generate 50+ apps across all three tiers
- Compare with old-style apps on: quality, generation time, token cost, operator feedback
- Iterate component catalog based on what the LLM struggles to express
- Add components for any patterns that come up repeatedly

### Out of scope for V1 of factory:
- Tier 2 (layout edits) — V1.1
- Tier 3 (full edits) — V1.2
- Component marketplace — V2
- Operator-uploaded components — V2
- AI-assisted customization ("operator, make this more elegant") — V1.1

---

## 13. Open questions for review

1. **License coverage.** Need written confirmation from Homer that Extended License covers TextOS's specific case. Stop work if it doesn't — we'd need a different component library.

2. **Custom JS in components.** Some apps need custom logic (recommendation algorithms, dynamic calculations). Should we:
   a. Have components include parameterized JS that the LLM configures with data?
   b. Have the LLM generate a small custom JS module that gets injected after assembly?
   c. Both, depending on complexity?

3. **Component versioning.** When a component is updated (bug fix, design improvement), do existing apps using it automatically get the new version, or are they pinned? Default suggestion: pin on creation, allow opt-in upgrade with one-click "rebuild with current components."

4. **Theme system depth.** How many theme variables to expose? Just colors + fonts (simple), or full control over spacing, shadows, border radii (powerful but harder to design good defaults)?

5. **What about Tailwind, shadcn, others?** We have CLAUDE.md saying no Tailwind for TextOS itself. Generated apps are sandboxed — they could use anything. Homer is Bootstrap 5 which is fine. But worth asking: is there a more modern alternative that gives the same coverage with better-looking defaults?

6. **The Astro question for TextOS itself.** Separate from this PRD, but tangentially related — TextOS's own UI is hand-built Astro without a component library. The factory work doesn't help TextOS itself. Worth considering whether the Manager and Builder pages should adopt a similar component-driven approach in V2.

7. **Operator UI for component selection in V1.** Default is the LLM picks. Should we let operators see and override the LLM's choices in V1, or hold that for V1.1? I lean V1.1 — keep V1 magic.

8. **Free-tier limit on apps.** With unlimited apps, we'll burn tokens on operators who generate and abandon. Cap per business per month? Or soft cap with upsell to remove the limit?

---

## 14. Success criteria

V1 of the factory is successful if:

- **Generation time** drops from 40-90s to under 25s average across all tiers
- **Token cost** drops to under 3500 LLM tokens per generation average
- **Quality consistency** — pick 10 random generated apps, all 10 should look professionally polished without manual review
- **Operator engagement** — > 50% of operators who generate one app generate a second app within a week
- **Edit tier adoption** — > 30% of operators use the free style edits feature within their first app's lifetime
- **No regression in functional quality** — generated apps work as well as today's apps, with the same form / paywall / save behaviors

---

## 15. Risks

**Highest priority risks:**

1. **License doesn't cover the use case.** Mitigation: confirm in writing before spending implementation time. If denied, evaluate alternatives (Tabler, Volt, or building a smaller bespoke library).

2. **Components can't express the variety of apps we need.** Mitigation: start with the 15 MVP components covering the patterns we've already seen; expand based on actual generation attempts. If the LLM keeps choosing "I need a component that doesn't exist," that's the signal to add it.

3. **Operator UX of tiered edits feels confusing.** Mitigation: start with Tier 1 (style only) which is the simplest. Don't ship Tier 2/3 until the simple case has been observed in production.

4. **Composition specs are harder for the LLM to produce reliably than raw HTML.** Mitigation: aggressive examples in the prompt, validation pass after generation, fall back to "raw HTML mode" for apps that can't be composed cleanly.

5. **The factory becomes a bottleneck — every new app pattern requires platform-side component work.** Mitigation: keep the catalog growing aggressively; track "components requested but missing" via the LLM's logs; add new components weekly.

---

## 16. Why this is the right architectural bet

The bet is that **most apps share most components**. A charcuterie quiz and a fitness recommender share: hero, multi-step form, result card, CTA. Their differences are content, ordering, and result logic — not visual primitives.

If that's true, this architecture wins on every dimension:
- **Cost** drops because the LLM does less work
- **Speed** improves because assembly is deterministic
- **Quality** improves because components are battle-tested
- **Consistency** improves because the design system is enforced at the template level
- **Customization** becomes safe because tiers are built into the structure
- **Extensibility** improves because adding an app type means adding components, not reworking prompts

The bet might be wrong for highly specialized apps (interactive simulations, complex visualizations). For those, the factory has an escape hatch: the LLM-generated custom JS module. And in the worst case, those apps can stay in the legacy raw-HTML pipeline.

But for the 80% of apps that are "ask questions, recommend something, ask for a sale" — which is most of what operators want — composition is dramatically better than generation.

---

## 17. What to do next

**Tonight:** Sleep.

**Tomorrow morning:**
1. Email Homer support — confirm Extended License covers the use case
2. While waiting for response, review this PRD critically — what's missing, what's wrong
3. Decide on the open questions in §13
4. Start with Phase 1 (multi-app support) — it's prerequisite work that ships value immediately
5. If license is confirmed by end of day, buy it and start Phase 0 (asset upload)

**This week:**
- Phases 0, 1, 2 (license + assets + multi-app + component catalog)
- One generation through the new pipeline by end of week

**Next week:**
- Phase 3 (pipeline rewrite)
- Phase 4 (style edits)
- Initial measurement

---

_End of PRD draft._

---

# Addendum A: Homer v3.2.0 Integration Specifics

_Added after reviewing the official Homer documentation bundle (changelog, folder-structure, getting-started, html-structure, theme-skin-setup, dark-mode, rtl-version, sources, index)._

## A.1 Version pin

**Homer v3.2.0** (released 2 July 2025), Bootstrap 5.3.6 base.

The 3.0 release (2 June 2025) was a complete rewrite — six built-in skin presets, full SCSS/Gulp modular architecture, native Bootstrap 5 dark mode. We pin to 3.2.0 specifically. Earlier 2.x versions do not have the skin system this PRD depends on.

License: Extended ($799 one-time), confirmed by Homer support to cover TextOS's SaaS-generation use case.

## A.2 What we ship to R2

Homer's ZIP delivers in this structure:

```
Admin/
  dist/                ← Production-ready compiled output
    assets/
      css/
      js/
      images/
      data/
  src/                 ← SCSS sources + Gulp build chain (NOT shipped)
    scss/
    js/
    html/partials/
  package.json
  gulpfile.js
  yarn.lock
```

**We ship only `Admin/dist/assets/`** to R2 under `apps.textos.ai/homer/`. The `src/` folder, `package.json`, `gulpfile.js`, etc. stay in our private archive — they're only needed if we ever want to customize the build (which we don't, see A.6 on overrides).

**Final R2 layout:**

```
apps.textos.ai/homer/
  assets/
    css/
      vendor.min.css      ← All 3rd party CSS
      app.min.css         ← Homer's Bootstrap 5 + custom (LTR)
      app-rtl.min.css     ← RTL variant
      icons.min.css       ← Tabler + Lucide icon fonts
    js/
      config.js           ← Theme/skin runtime config (loads in HEAD)
      vendor.min.js       ← jQuery + all plugins
      app.js              ← Homer behaviors
    images/
      favicon.ico         ← Default; overridable per-app
    data/                 ← Sample data (optional, may skip)
```

Cloudflare cache headers: `Cache-Control: public, max-age=31536000, immutable` on every asset. Filename versioning (e.g. `app.min.css?v=3.2.0`) so we can bust cache on upgrade without renaming files. R2 + Cloudflare's edge CDN delivers globally with sub-100ms latency after first request.

## A.3 Exact `<head>` structure for every generated app

Order matters — `config.js` must load before the CSS so it can set `data-skin` / `data-bs-theme` attributes before paint:

```html
<!DOCTYPE html>
<html lang="en" data-skin="default" data-bs-theme="light">
<head>
  <meta charset="utf-8">
  <title>{app_title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <link rel="shortcut icon" href="https://apps.textos.ai/homer/assets/images/favicon.ico">

  <!-- Theme Config Js (loads FIRST) -->
  <script src="https://apps.textos.ai/homer/assets/js/config.js?v=3.2.0"></script>

  <!-- Homer CSS bundle -->
  <link href="https://apps.textos.ai/homer/assets/css/vendor.min.css?v=3.2.0" rel="stylesheet">
  <link href="https://apps.textos.ai/homer/assets/css/app.min.css?v=3.2.0" rel="stylesheet" id="app-style">
  <link href="https://apps.textos.ai/homer/assets/css/icons.min.css?v=3.2.0" rel="stylesheet">

  <!-- TextOS overrides (optional, app-specific) -->
  {textos_brand_overrides_css}
</head>
<body>
  {composed_app_content}

  <!-- Homer JS (loads at end of body) -->
  <script src="https://apps.textos.ai/homer/assets/js/vendor.min.js?v=3.2.0"></script>
  <script src="https://apps.textos.ai/homer/assets/js/app.js?v=3.2.0"></script>

  <!-- TextOS app shell (TXAPP global, analytics, save/download) -->
  {textos_app_shell_js}

  <!-- App-specific logic (LLM-generated, optional) -->
  {app_specific_js}
</body>
</html>
```

The `id="app-style"` on the main CSS link is intentional and Homer-native — it lets us swap to `app-rtl.min.css` at runtime by setting `document.getElementById('app-style').href = '.../app-rtl.min.css'`.

## A.4 Theme system — the data-skin breakthrough

This replaces the abstract "theme variables" approach in §4.3 of the original PRD. Homer's runtime theme system is controlled entirely by HTML attributes on the `<html>` element — no CSS rewriting, no SCSS recompilation.

**Three attribute axes:**

| Attribute | Values | Effect |
|---|---|---|
| `data-skin` | `default`, `two`, `three`, `four`, `five`, `six` | Picks one of 6 pre-built color palettes |
| `data-bs-theme` | `light`, `dark` | Toggles dark mode (Bootstrap 5 native) |
| `dir` | (omitted) or `rtl` | LTR vs RTL layout; also requires swapping `app.min.css` → `app-rtl.min.css` |

Preview URLs for each skin (live):
- Default: https://webapplayers.com/homer/demos/index.html
- Skin Two: https://webapplayers.com/homer/demos/skin-two.html
- Skin Three: https://webapplayers.com/homer/demos/skin-three.html
- Skin Four: https://webapplayers.com/homer/demos/skin-four.html
- Skin Five: https://webapplayers.com/homer/demos/skin-five.html
- Skin Six: https://webapplayers.com/homer/demos/skin-six.html

**Total base presets shipped:** 6 skins × 2 schemes (light/dark) = **12 visual presets out of the box**, zero custom CSS required. Add RTL and that doubles to 24.

## A.5 Revised composition spec — `theme` block

Replaces the abstract theme fields in §4.3 of the original PRD:

```json
"theme": {
  "skin": "two",                        // default | two | three | four | five | six
  "color_scheme": "light",              // light | dark
  "rtl": false,                         // true triggers app-rtl.min.css swap
  "primary_color_override": "#8B4513",  // optional, overrides --bs-primary
  "accent_color_override": null,        // optional, overrides --bs-secondary
  "font_family_override": null          // optional, future
}
```

The HTML assembler:
1. Sets `data-skin`, `data-bs-theme`, and `dir` attributes on `<html>` based on the spec
2. If `rtl: true`, the assembler emits `<link href=".../app-rtl.min.css">` instead of `app.min.css`
3. If any color overrides are set, the assembler emits a tiny inline `<style>` block:
   ```html
   <style>:root { --bs-primary: #8B4513; --bs-primary-rgb: 139, 69, 19; }</style>
   ```
   This is the LAST stylesheet, so it wins. Bootstrap 5's variable system makes this surgical — overriding `--bs-primary` cascades to every button, badge, link, and accent automatically.

## A.6 Why we don't run gulp

The Homer source ships with a full Gulp 4.0.1 + Yarn build chain (`gulp`, `gulp build`, `gulp rtl`, `gulp rtlBuild`). We could fork this and customize SCSS variables per-operator (different `$primary` values, custom fonts, etc.).

**We won't, because:**
- Each customization would require a build step → minutes of CI time per generation
- We'd need to host a build worker (separate infrastructure)
- We'd ship per-operator CSS bundles (multiplies cache misses, defeats the global-cache win)
- Bootstrap 5 CSS variables let us override almost anything at runtime with a 10-line inline `<style>` block

The Gulp chain stays in our private archive in case we need it later (e.g., to add a custom font file or a 7th skin). For all V1 customization, runtime CSS variable overrides win.

## A.7 Generated apps are landing pages, NOT admin dashboards

Homer's HTML structure (per html-structure.html) is built around the admin chrome:

```html
<body>
  <div class="wrapper">
    <div class="sidenav-menu">...</div>
    <header class="app-topbar">...</header>
    <div class="content-page">
      <div class="container-fluid">
        {page content}
      </div>
    </div>
  </div>
</body>
```

**Our generated apps do NOT use this chrome.** No sidebar, no topbar, no `wrapper`/`content-page` classes. Mini-apps are single-purpose pages (quiz, calculator, recommender) — they want a clean centered layout, not an admin shell.

**Generated app body structure:**

```html
<body>
  <div class="container my-4 my-md-5" style="max-width: 720px">
    {composed components from catalog}
  </div>

  <script src="...vendor.min.js"></script>
  <script src="...app.js"></script>
  <script>/* TXAPP shell */</script>
  <script>/* app-specific logic */</script>
</body>
```

Bootstrap's container + components work standalone. We get Homer's styling (buttons, forms, cards, badges, alerts, modals) without inheriting the admin layout.

Some app types may want wider layouts (e.g., a comparison-table app that needs 1140px): the `container-xl` variant handles that. The composition spec includes a `layout_width` field:

```json
"layout": {
  "max_width": "narrow"   // narrow (720px) | medium (960px) | wide (1140px) | full
}
```

## A.8 Bundled third-party libraries (from sources.html)

Homer's `vendor.min.css` and `vendor.min.js` bundle these libraries together. Components in our catalog can rely on any of them being present without additional script tags:

**Forms & input:** bootstrap, choices.js, typeahead.js, nouislider, flatpickr, quill

**Data display:** datatables.net (basic, bs5, buttons, fixedcolumns, fixedheader, keytable, responsive, select), prismjs (code highlighting)

**Visualizations:** chart.js, jsvectormap, leaflet (maps), spinkit (spinners)

**Interaction:** sweetalert2, glightbox, clipboard, ladda (loading buttons), simplebar, sortablejs

**Layout:** masonry-layout, muuri (grid layouts)

**Utilities:** jquery, moment, jszip, pdfmake, web-animations-js

**Icons:** lucide, tabler-icons (5000+ icons)

**Bundle size estimate:** vendor.min.js + vendor.min.css ≈ 800KB-1.2MB gzipped. Substantial, but loads ONCE and is cached aggressively. Per-app marginal cost is just the small custom HTML/JS we add.

## A.9 Operator Tier 1 (style edit) UI — much simpler now

Original PRD called for color pickers + font selectors. With Homer's skin system, V1 of the style-edit UI is just three picklists:

**Style Edit panel (operator-facing):**

```
Theme Preset:    [Default ▼] (Default · Classic · Material · Modern · SaaS · Flat)
Color Mode:      [● Light  ○ Dark]
Brand Color:     [#8B4513] (color picker — overrides primary)
Layout Width:    [Narrow ▼] (Narrow · Medium · Wide · Full)

[Apply Changes]    Free edits remaining: 2 of 3
```

Each click of "Apply Changes" updates the composition spec's `theme` block, the HTML reassembles, and the operator sees the result instantly. No file rebuilds, no LLM calls, no token costs — pure config change.

The three free edits / pay-after model from §7 still applies, but each "edit" is cheap because all we're changing is JSON values.

Font selection, accent color, and advanced overrides come in V1.1.

## A.10 Dark mode & RTL — first-class, not afterthoughts

Both are one-attribute toggles in Homer. We can expose both in Tier 1 from day one:

- **Dark mode toggle** for the operator: `data-bs-theme="dark"` on `<html>`. Useful for apps where the operator's brand or audience prefers dark UI.
- **RTL toggle** for operators serving Arabic, Hebrew, Persian, Urdu, etc. audiences: `dir="rtl"` + swap CSS to `app-rtl.min.css`. Adds international market reach with zero code work.

The composition spec's `rtl` field flips both atomic changes.

## A.11 Updated implementation phases (Phase 0 revisited)

Phase 0 in the original PRD assumed asset upload was straightforward. With Homer's actual structure, Phase 0 has concrete sub-tasks:

**Phase 0a — Asset extraction & inventory** (½ day)
- Extract `Admin/dist/assets/` from the Homer ZIP
- Verify file list matches A.2 spec
- Generate manifest with file sizes, checksums
- Archive `Admin/src/` separately (private bucket, not served)

**Phase 0b — R2 upload & CDN config** (½ day)
- Upload `assets/` tree to `apps.textos.ai/homer/`
- Configure Cloudflare cache headers (long-lived immutable)
- Add `?v=3.2.0` query string convention to all asset URLs
- Verify cross-origin loading from generated app iframes
- Test load time from 3 global regions

**Phase 0c — Skin verification** (½ day)
- Render a test page with each skin × theme combo (12 base presets)
- Render the same page in RTL with each skin
- Document any combos that look broken / unusable
- Screenshot all 24 combos for the operator UI picker

**Phase 0d — License & redistribution check** (½ day)
- Confirm Extended License paperwork on file
- Document the SaaS-generation use case for our records
- Verify Homer's update policy — how we get notified of new releases

Total: **2 days for Phase 0**, then Phase 1 (multi-app support) can start.

## A.12 Updates to §13 (open questions)

The Homer specifics resolve several open questions from the original PRD:

- **Q4 (Theme system depth):** Solved. Use Homer's skins + Bootstrap 5 CSS variables. Don't build a custom theme engine.
- **Q5 (Tailwind/shadcn/other alternatives):** Closed. Homer is paid, licensed, and comprehensive enough. Move forward.

**New open questions raised by the docs:**

9. **Bundle size impact on first paint.** vendor.min.js is heavy (~600KB gzipped). For a calculator that doesn't use DataTables or FullCalendar or Quill, we're shipping unused code. V2 consideration: split the bundle by use case. V1: ship the whole thing — simplicity beats optimization.

10. **Updates from Homer.** v3.2.0 dropped 2 July 2025. They've been adding framework variants (ASP.NET, Laravel, Django, etc.) but we only care about the HTML/CSS variant. Set up a watcher (RSS, email subscription, manual check quarterly) to know when 3.3.0 ships. Have a process for testing + redeploying.

11. **config.js — what's in it?** It loads first in HEAD and likely reads localStorage to persist user theme preferences. For our generated apps, we may want to PREVENT this (operator sets the theme, visitor shouldn't override). Need to inspect config.js and decide whether to ship it as-is, modify, or skip entirely.

12. **Should we strip the demo's admin-specific assets?** Homer ships logo files, sample images, sample data JSON. We don't need most of these. V1: keep the bundle as shipped to avoid breaking implicit dependencies. V1.1: audit and trim what we can.

---

_End of Addendum A._
