# Homer for TextOS Platform Pages — PRD

**Version:** Draft 1
**Date:** May 25, 2026
**Author:** Rob Gaudet (architect) + Claude
**Status:** Pre-implementation, companion to the Component Factory PRD
**Related:** `textos-component-factory-prd.md`

---

## 1. Why this exists

The Component Factory PRD adopts Homer for **generated mini-apps** — the things operators publish for their visitors. This document covers the other use of the same Homer license: **TextOS's own platform UI** — the pages operators see when they log into app.textos.ai.

The two uses are independent decisions architecturally but share infrastructure (R2 bundle, license, skin system). Doing them in parallel keeps the platform visually coherent and amortizes the integration work.

**The shift on the platform side:** stop hand-building admin layouts in Astro from scratch. Use Homer's chrome (wrapper, sidenav, topbar, customizer) as the platform shell and slot TextOS-specific content into it.

---

## 2. Scope

**In scope for V1 of this PRD:**

- New platform pages that don't exist yet (DayCycle)
- Existing platform pages that are placeholder-quality (the `/apps` page)
- Existing pages that are functional but basic (settings, profile, listing pages)
- The TextOS nav structure mapped to Homer's `side-nav`

**Out of scope (for now, possibly forever):**

- Business Builder page (`/business/{slug}/builder`) — high stakes, complex behavior, deferred
- Live page (`/business/{slug}/live`) — recently fixed, deferred
- Public business websites (`/sites/{slug}/...`) — not platform pages, separate concern
- Generated mini-apps — covered by Component Factory PRD
- The TextOS marketing site (`textos.ai/`) — public marketing, different design constraints

---

## 3. The two-use Homer model (recap)

Both uses share the same R2 bundle at `apps.textos.ai/homer/`. Both are covered by the Extended License. The only difference is which Homer structures they use:

| Use | Pages | Layout structure |
|---|---|---|
| **Generated mini-apps** | Operator apps served via iframe | Bootstrap containers only — NO admin chrome |
| **TextOS platform pages** | app.textos.ai/* | Full Homer chrome — `wrapper` → `sidenav-menu` + `app-topbar` + `content-page` |

The implication: the same Homer asset bundle serves landing-page-style content (mini-apps) and admin-style content (platform pages) just by including different HTML scaffolding in the body.

---

## 4. Architectural integration with Astro

TextOS is built on Astro 5. Astro compiles `.astro` files to HTML at build time. Homer is plain HTML/CSS/JS. They compose cleanly.

### 4.1 Two layouts coexist

```
src/layouts/
  BaseLayout.astro       ← existing TextOS layout (keep for Builder, Live, legacy)
  HomerLayout.astro      ← NEW — wraps content in Homer admin chrome
```

New pages opt into Homer by importing `HomerLayout`. Old pages keep using `BaseLayout`. The two design systems coexist temporarily.

### 4.2 HomerLayout.astro structure

```astro
---
// HomerLayout.astro
const {
  title,
  pageTitle,
  pageSubtitle,
  skin = 'default',
  theme = 'dark',
  rtl = false
} = Astro.props;
---
<!DOCTYPE html>
<html lang="en"
      data-skin={skin}
      data-bs-theme={theme}
      {...(rtl ? { dir: 'rtl' } : {})}>
<head>
  <meta charset="utf-8">
  <title>{title} · TextOS</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="shortcut icon" href="/favicon.ico">

  <script src="https://apps.textos.ai/homer/assets/js/config.js?v=3.2.0"></script>
  <link href="https://apps.textos.ai/homer/assets/css/vendor.min.css?v=3.2.0" rel="stylesheet">
  <link href={`https://apps.textos.ai/homer/assets/css/${rtl ? 'app-rtl' : 'app'}.min.css?v=3.2.0`}
        rel="stylesheet" id="app-style">
  <link href="https://apps.textos.ai/homer/assets/css/icons.min.css?v=3.2.0" rel="stylesheet">

  <!-- TextOS brand overrides -->
  <style>
    :root {
      --bs-primary: #c8832a;
      --bs-primary-rgb: 200, 131, 42;
      /* additional TextOS brand variables here */
    }
  </style>

  <slot name="head" />
</head>
<body>
  <div class="wrapper">

    <!-- TextOS sidenav with operator vocabulary -->
    <SideNav currentPage={Astro.url.pathname} />

    <!-- Topbar with operator chat, notifications, profile -->
    <TopBar />

    <div class="content-page">
      <div class="container-fluid">
        {pageTitle && (
          <div class="page-title-box">
            {pageSubtitle && <div class="text-muted">{pageSubtitle}</div>}
            <h2 class="page-title">{pageTitle}</h2>
          </div>
        )}

        <slot />
      </div>

      <Footer />
    </div>

  </div>

  <!-- Homer's customizer offcanvas -->
  <Customizer />

  <script src="https://apps.textos.ai/homer/assets/js/vendor.min.js?v=3.2.0"></script>
  <script src="https://apps.textos.ai/homer/assets/js/app.js?v=3.2.0"></script>

  <slot name="scripts" />
</body>
</html>
```

### 4.3 Componentization in Astro

Decompose Homer's chrome into Astro components TextOS can reuse:

```
src/components/homer/
  SideNav.astro         ← TextOS-vocabulary nav items
  TopBar.astro          ← Search, notifications, operator profile
  Customizer.astro      ← Skin/theme/sidebar picker (replaces footer bar)
  Footer.astro          ← TextOS-branded footer
  PageTitle.astro       ← Breadcrumb + h1
  KpiCard.astro         ← Reusable KPI tile
  StatRow.astro         ← Multi-stat horizontal row
  ChartCard.astro       ← Card-wrapped Chart.js component
  EmptyState.astro      ← Standard empty/zero-data display
```

These get added incrementally. V1 only needs `SideNav`, `TopBar`, `Customizer`, `Footer`, and `PageTitle` to ship a complete platform page.

---

## 5. Navigation mapping

The current TextOS nav order (from system prompt):

```
👤 Personal Website → 🏢 Business Builder → ⚡ DayCycle → Notes & Capture →
Website Builder → Blog → Journal → Timeline
```

Mapped to Homer's `side-nav` structure with operator vocabulary preserved:

```html
<div class="sidenav-menu">
  <a href="/" class="logo">
    <img src="/textos-logo-mark.jpg" alt="TextOS" class="logo-lg">
  </a>

  <div class="scrollbar" data-simplebar>
    <ul class="side-nav">
      <li class="side-nav-title">Your Operator</li>

      <li class="side-nav-item">
        <a href="/persona" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-user"></i></span>
          <span class="menu-text">Your Public Persona</span>
        </a>
      </li>

      <li class="side-nav-item">
        <a href="/business" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-building"></i></span>
          <span class="menu-text">Your Businesses</span>
        </a>
      </li>

      <li class="side-nav-item">
        <a href="/daycycle" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-sun"></i></span>
          <span class="menu-text">DayCycle</span>
        </a>
      </li>

      <li class="side-nav-title">Your Library</li>

      <li class="side-nav-item">
        <a href="/notes" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-notes"></i></span>
          <span class="menu-text">Notes &amp; Capture</span>
        </a>
      </li>

      <li class="side-nav-item">
        <a href="/sites" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-world"></i></span>
          <span class="menu-text">Sites</span>
        </a>
      </li>

      <li class="side-nav-item">
        <a href="/blog" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-pencil"></i></span>
          <span class="menu-text">Blog</span>
        </a>
      </li>

      <li class="side-nav-item">
        <a href="/journal" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-book"></i></span>
          <span class="menu-text">Journal</span>
        </a>
      </li>

      <li class="side-nav-item">
        <a href="/timeline" class="side-nav-link">
          <span class="menu-icon"><i class="ti ti-timeline"></i></span>
          <span class="menu-text">Timeline</span>
        </a>
      </li>
    </ul>
  </div>
</div>
```

Notes:
- Section dividers ("Your Operator", "Your Library") group items naturally
- TextOS's "Personal Website" becomes "Your Public Persona" (operator vocabulary)
- "Business Builder" becomes "Your Businesses" — operators see a list, then enter a specific business
- The `[active]` class gets added dynamically based on current route
- Icons use Tabler's `ti ti-*` classes — Homer ships with 5000+

---

## 6. Operator vocabulary preservation rules

Homer's demo uses words TextOS forbids: "Dashboard", "Apps", "Settings", "Get Started", "Generate", etc. When porting Homer patterns we keep the HTML structure but REWRITE every label.

**Forbidden words audit before every page ships:**

| Homer uses | TextOS replaces with |
|---|---|
| Dashboard | Command Center / Your [thing] |
| Apps | Tools / Your Apps (operator-facing) |
| Settings | Preferences |
| Profile | Your Operator |
| Get Started | Run the Play / Begin |
| Generate / Process | Compose / Build / Brief |
| Task | Play / Plan |
| Automation / Tool / Bot | Your COO |
| Execute | Authorize / Run |
| Notifications | Updates |
| Account | Your Operator |
| Logout | End Session |

**Lint enforcement:** add a pre-commit grep that fails on any HTML file containing forbidden words. CLAUDE.md already lists them; we extend it with the lint script.

---

## 7. Theme alignment — picking TextOS's Homer skin

TextOS's existing aesthetic:
- Background: `#0a0a0a` (near-black)
- Primary amber: `#c8832a`
- Secondary cyan: `#00d4ff`
- Fonts: Bebas Neue (headers), Space Grotesk (body), JetBrains Mono (data)
- Vibe: terminal-meets-luxury, dark, confident, slightly retro-tech

Homer ships six skins. We don't have Claude-side visual access; Rob compares them tomorrow morning at these URLs:

- Default: https://webapplayers.com/homer/demos/index.html
- Skin Two: https://webapplayers.com/homer/demos/skin-two.html
- Skin Three: https://webapplayers.com/homer/demos/skin-three.html
- Skin Four: https://webapplayers.com/homer/demos/skin-four.html
- Skin Five: https://webapplayers.com/homer/demos/skin-five.html
- Skin Six: https://webapplayers.com/homer/demos/skin-six.html

**Tomorrow's decision:** view each in dark mode. Pick the one whose default color palette is closest to TextOS's amber-on-near-black. Then override `--bs-primary` to `#c8832a` to nail the brand color exactly.

**Recommended config baseline (subject to skin selection):**

```html
<html lang="en" data-skin="[CHOSEN]" data-bs-theme="dark">
```

```css
:root {
  --bs-primary: #c8832a;
  --bs-primary-rgb: 200, 131, 42;
  --bs-link-color: #00d4ff;        /* TextOS cyan for links */
  --bs-link-hover-color: #33dfff;
}
```

**Font handling:** Bebas Neue / Space Grotesk are not in Homer. Add via Google Fonts in HomerLayout's `<head>`, override Bootstrap's `--bs-font-sans-serif` and `--bs-font-monospace`. Headers using Bebas Neue get a utility class `.font-display` for explicit application.

```css
:root {
  --bs-font-sans-serif: 'Space Grotesk', system-ui, sans-serif;
  --bs-font-monospace: 'JetBrains Mono', monospace;
}
.font-display {
  font-family: 'Bebas Neue', sans-serif;
  letter-spacing: 0.04em;
}
```

---

## 8. Theme picker — retire the TextOS footer bar?

TextOS currently ships a hand-built footer bar:

```
Text [A][A][A] | Style [⬤⬤⬤⬤⬤⬤]
```

Six theme dots (default, warm, forest, blue, minimal, crimson), three font sizes, localStorage keys `textos_fs` / `textos_theme`.

Homer ships a customizer offcanvas covering all of this plus more:
- 6 skin presets (1:1 with TextOS's 6 themes — direct map)
- Light / Dark mode toggle
- Topbar color (Light / Dark / Gray)
- Sidenav color (Light / Dark / Gray)
- Sidebar size (Default / Collapse / Offcanvas)
- Layout position (Fixed / Scrollable)
- Sidebar user-info toggle
- Reset button

**Recommendation: retire the footer bar. Adopt Homer's customizer.**

Reasons:
- Homer's customizer is more capable than what TextOS has
- It's already integrated with `data-skin` / `data-bs-theme` / sidebar size persistence
- Maintains one source of truth for theme state
- The footer-bar font-size control (12px / 15px / 26px) can become a customizer row labeled "Text Size"
- We can simplify the customizer for operators by hiding the topbar/sidenav granular color controls in V1 — just skin + mode + text size

**Migration plan for theme persistence:**
- New localStorage keys `homer_data_skin`, `homer_data_bs_theme`, `homer_text_size` (or whatever Homer uses by default)
- One-time migration on first visit: read old `textos_theme` → map to a Homer skin → write to Homer's keys → continue normally
- Old `textos_fs` → map to closest Homer text size → write → continue
- After 30 days of telemetry showing no users on the legacy keys, delete the migration code

**Map of TextOS themes to Homer skins:**

Tomorrow's manual exercise. Likely outcome:
- TextOS default (dark+amber) → Homer dark mode, [chosen skin]
- TextOS warm → Homer skin with warm tones, dark mode
- TextOS forest → green-leaning Homer skin
- TextOS blue → blue-leaning Homer skin
- TextOS minimal → light mode of any skin
- TextOS crimson → red-leaning Homer skin

If Homer's six don't cleanly map to TextOS's six, we either pick the closest match (good enough) or compile a 7th custom skin via SCSS (only if a TextOS theme has strategic value worth the build complexity — probably not).

---

## 9. Migration order

**Wave 1 — Greenfield (no migration risk):**
1. **DayCycle** (`/daycycle`) — doesn't exist yet, perfect starting point. Built directly in HomerLayout.
   - Uses Homer's calendar layout for the day view
   - Uses Homer's chat layout for the COO conversation panel
   - Uses Homer's KPI cards for the focus-area metrics
   - V1.1 of TextOS, post-launch

**Wave 2 — Low-risk thin pages (current implementations are basic):**
2. **/apps page** — current implementation is placeholder. Re-layout using Homer's file-manager pattern (grid of app cards with metadata + actions).
3. **/business listing page** — if/when this exists as a page that lists all of an operator's businesses
4. **/settings** (or whatever the preferences page is called)
5. **/operator** (profile / persona settings)

**Wave 3 — Existing functional but basic pages:**
6. **/notes** — Homer has notes / kanban patterns to copy
7. **/journal** — Homer has timeline + chat patterns
8. **/timeline** — Homer ships a vertical timeline component (`pages-timeline.html`)
9. **/blog** — Homer's forum + landing-page hybrid
10. **/sites** (Website Builder) — Homer's project-board + file-manager hybrid
11. **/persona** (Public Persona) — Homer's profile + landing-page hybrid

**Wave 4 — High-stakes, deferred indefinitely:**
12. **Business Builder** (`/business/{slug}/builder`) — defer until 12+ months stable
13. **Live page** (`/business/{slug}/live`) — defer until 12+ months stable

**Out of scope for THIS PRD entirely:**
- Public-facing sites at `/sites/{slug}/*` — those are operator-branded, not TextOS-platform
- The marketing site at `textos.ai` — different design system entirely

---

## 10. Eventual Builder / Live migration plan

When the time comes (V2+, possibly never):

**Pre-migration requirements:**
- Both pages must be stable in production for at least 6 months with no architectural changes
- All P0/P1 bugs cleared in the last 90 days
- Test coverage for critical user flows
- Side-by-side rendering test: HomerLayout version vs current version, parity confirmed visually

**Migration approach:**
- Build a parallel HomerLayout version under a flag (e.g., `?layout=homer`)
- Internal testing for 2 weeks
- A/B test for 2 weeks
- Switch default for 10% of users
- Roll forward weekly
- Delete old version after 60 days at 100%

**Risk gates:**
- Any drop in conversion or task completion = roll back immediately
- Any new bug class introduced = roll back
- Any operator complaints about layout = pause and review

The honest answer: if Builder and Live keep working in their current form, we may never migrate them. The cost of migration outweighs the benefit if they're already stable. The V2 plan is "consider it" not "commit to it."

---

## 11. Implementation phases

### Phase 1 — Foundation (1-2 days)
- Component Factory PRD Phase 0 must be complete first (Homer assets on R2)
- Create `HomerLayout.astro`
- Create the 5 base components: SideNav, TopBar, Customizer, Footer, PageTitle
- Inject TextOS brand overrides via `:root` CSS variables
- Add Bebas Neue / Space Grotesk via Google Fonts
- Lint script for forbidden vocabulary

### Phase 2 — Skin selection (½ day)
- Rob reviews all 6 Homer skins at the demo URLs
- Picks the base skin closest to TextOS's identity
- Configures `--bs-primary` and `--bs-link-color` overrides
- Side-by-side comparison: HomerLayout rendering of a sample page vs current TextOS BaseLayout

### Phase 3 — Pilot page: /apps redesign (1-2 days)
- Re-implement the current `/apps` page using HomerLayout
- Use Homer's file-manager layout as the structural reference
- Operator UI: grid of apps with KPIs, actions, "Create New" CTA
- Side-by-side deploy: `/apps` (HomerLayout) vs `/apps-classic` (BaseLayout) for comparison
- 1-week soak; if good, retire the classic version

### Phase 4 — DayCycle build (V1.1 timing, ~1 week)
- Built natively in HomerLayout from day one
- Uses Homer's calendar + chat + KPI patterns
- See the DayCycle section of the master PRD for feature specifics
- Greenfield, no migration risk

### Phase 5 — Theme persistence migration (½ day)
- Add localStorage key migration shim
- Map old TextOS theme keys → new Homer keys on first visit
- Telemetry to confirm 100% of active users migrated
- After 30 days, remove migration code

### Phase 6 — Wave 3 pages (incremental, 1-2 days each)
- Migrate Notes, Journal, Timeline, Blog, Sites, Persona one at a time
- Each migration: build HomerLayout version under a flag, A/B for a week, switch default
- Estimated 4-6 weeks of incremental work

### Phase 7 — Cleanup (ongoing)
- Remove BaseLayout when no pages reference it (except Builder and Live)
- Delete migration shims
- Consolidate CSS

**Total V1 of this PRD:** Phases 1, 2, 3 (~4-5 days work). Phase 4 (DayCycle) is its own V1.1 effort. Phases 5-7 are incremental.

---

## 12. Open questions

1. **Skin choice.** Which of Homer's 6 skins is the visual base? Tomorrow's call after reviewing the demos.

2. **Customizer simplification.** Homer's customizer offers 6+ controls. Do we expose all of them to operators, or simplify to 3-4 (skin, mode, text size)? Lean simplification — fewer choices, less confusion.

3. **Logo placement and sizing.** Homer's logo slot in the sidenav is small (28px-ish). TextOS's red T lettermark needs to render there cleanly. Confirm visual.

4. **Sidebar collapse behavior on mobile.** Homer's offcanvas works well, but the breakpoint may need adjustment for TextOS's UX.

5. **Right-side panel.** Some TextOS use cases (Builder, Live) have a 5-column layout with right-side agent chat. Homer's `wrapper` doesn't natively support a fixed right panel — we'd add a `right-panel` div as a sibling of `content-page`. Not a V1 concern but worth noting.

6. **Topbar contents.** Homer's topbar has search, language, notifications, profile, mega-menu. TextOS may want different items — operator chat shortcut, business switcher, COO status, etc. The TopBar component is where this gets defined.

7. **Per-operator skin choice persisted to Supabase or localStorage only?** If localStorage only, the operator's choice doesn't follow them across devices. If Supabase, we add a `preferences` column or table. Probably Supabase from day one — small change, big UX win.

8. **What about the WebApp Wrapper (TXAPP global)?** Generated apps have it; do platform pages need an equivalent? Probably no — platform pages are first-party TextOS code with direct access to whatever they need.

9. **Marketing site (`textos.ai`).** Out of scope for this PRD, but worth deciding eventually whether the marketing site also adopts Homer for visual consistency, or stays as-is.

---

## 13. Risks

1. **Two design systems coexist for a long time.** During migration, some pages use HomerLayout, others BaseLayout. They might look like two different products. Mitigation: pick a Homer skin that visually echoes the current TextOS aesthetic so the transition is invisible to most operators.

2. **Operator vocabulary erosion.** Homer's demo uses many forbidden words. Easy to copy-paste and forget to rewrite. Mitigation: lint script, code review checklist, and the addition of vocabulary tests to CI.

3. **Bootstrap variables vs TextOS tokens conflict.** Pages using HomerLayout inherit Bootstrap's variable system. Pages using BaseLayout use TextOS's custom tokens. If a shared component references both, things break. Mitigation: shared components only use one system at a time. Tag every component with its layout dependency.

4. **Customizer state desync.** If Homer's customizer writes to its own localStorage keys while old code still reads TextOS's keys, theme state goes inconsistent. Mitigation: Phase 5 migration shim, with one canonical localStorage key set going forward.

5. **CSS specificity wars.** Bootstrap's specificity + Homer's overrides + TextOS's overrides could produce CSS that's hard to debug. Mitigation: keep TextOS overrides minimal, layered, and well-commented. Avoid `!important`.

6. **Builder/Live look stale relative to new pages.** As new pages adopt Homer, Builder and Live (which keep their original look) might start to feel dated. Mitigation: accept this. Builder is the moneymaker — visual polish is secondary to functional stability. If it starts to feel painful enough, we revisit the migration decision.

7. **Homer updates break us.** A future Homer release could change selectors, class names, or skin structure. Mitigation: version-pin to 3.2.0 in R2 URLs. Test upgrades on a staging environment before promoting. Run a manual upgrade audit per Homer release.

---

## 14. Success criteria

V1 of platform-side Homer adoption is successful if:

- **HomerLayout ships with the `/apps` page redesign** within 1 week of Component Factory Phase 0
- **DayCycle ships in HomerLayout** in V1.1 — no parallel non-Homer version exists
- **Theme picker migration completes** without operator-visible regression
- **No operator complaints about visual inconsistency** between platform pages
- **Vocabulary audit passes** — zero forbidden words in shipped HTML
- **Page load times stay flat or improve** — Homer's bundle is cached, marginal CSS per page should be smaller than today's hand-built CSS
- **Builder and Live remain untouched** — they continue working, which is the goal

---

## 15. What to do tomorrow

**Morning (before any code):**
1. Open all 6 Homer skin demos in tabs
2. Switch each to dark mode (Homer's customizer makes this easy)
3. Note which feels closest to TextOS's amber-on-near-black aesthetic
4. Make the call. Record the skin number in this PRD's §7

**Morning (after skin selection):**
5. Component Factory PRD Phase 0a-0d (Homer assets to R2) — prerequisite for any HomerLayout work
6. Verify R2 serves the bundle correctly
7. Visual smoke test in a throwaway HTML page using the selected skin

**Afternoon (if Phase 0 complete):**
8. Scaffold `HomerLayout.astro` per §4.2
9. Build `SideNav.astro` with TextOS nav per §5
10. Test render on a hello-world page

**Decisions Rob owns:**
- Skin selection (§7)
- Customizer simplification depth (§12 Q2)
- Per-operator preference storage location (§12 Q7)

**Decisions Claude (or Claude Code) can move forward on:**
- HomerLayout structure
- SideNav nav items with TextOS vocabulary
- Theme persistence migration shim design
- Forbidden vocabulary lint script

---

## 16. Companion documents

- **Component Factory PRD** — `textos-component-factory-prd.md` (this PRD's sibling, covers generated mini-apps)
- **Homer documentation bundle** — the 9 HTML files (folder-structure, getting-started, html-structure, theme-skin-setup, dark-mode, rtl-version, sources, changelog, index)
- **TextOS master PRD** — referenced in CLAUDE.md, contains the original nav order and vocabulary rules

---

_End of PRD draft._
