# TrustLight — open work

Spans `textos-agent` and `trustlight-public`. It lives here because this is
the repo with version control: `trustlight-public` is a plain folder with no
`.git` and no remote, so anything recorded only there exists on one machine.
That is the same failure that left the e2e suites untracked until `6a210b0`.

`trustlight-public/BACKLOG.md` is a pointer at this file.

Last reviewed 2026-09-17.

---

## Deployment state

| | State |
|---|---|
| `textos-agent` | `main` = `origin/main` = `b16e6b0` |
| prod worker `textos-agent-dev` | `ea098094` — current with `main` |
| test worker `textos-agent-test` | current with `main` |
| `trustlight.com/api/*` zone route | **does not exist** |
| `trustlight.com` (the site) | **serves the pre-rewrite copy** |
| preview `directory-preview.trustlight-com.pages.dev` | current |
| `textos-web` | `ac279b1`, untouched by this work |

Both workers carry the full public API. Nothing points at it yet.

---

## OPEN

### 1. Zone route: `trustlight.com/api/*` → `textos-agent-dev`

**Blocks the site launch.** There is no `routes` block in `wrangler.toml`, so
this is a Cloudflare dashboard change or a new `routes` entry plus a redeploy.
Until it exists, `trustlight.com/api/directory/featured` returns the Pages HTML
fallback and the rewritten site would render its error state on every page.

Must land **before** the production site deploy, not after.

### 2. Production deploy of `trustlight-public`

Everything below is built, tested and live on the preview only:

- contractor-facing copy rewrite across all 13 pages (0 banned-vocabulary hits)
- the refund guarantee on `get-verified` and `start`
- the H2 card system, `/search`, and `/contractor/{slug}`
- `start.html` trimmed to the API's field contract (28 → 24 controls)
- `badge.html` repointed at real profile URLs, with an interim notice
- host-derived `API_BASE`, `/search` in nav and footer sitewide

Ships with `.\deploy.ps1 -Production`, after item 1.

### 3. A facets endpoint for the search filters

`GET /api/directory/facets` returning the distinct publishable values per
field, with counts. `/search` currently uses free-text inputs backed by a
`<datalist>` seeded from whatever rows are on screen.

More tractable than when this was first written: the trade vocabulary is now
a fixed list of 16, so a facets response for `trade` is enumerable rather than
open-ended. County and city are still open-ended.

Constraints inherited from the rest of the public API: explicit column
whitelist, no `select("*")`, no row spread, and counts must not make a
non-public record inferable.

### 4. Wire `start.html` to `POST /api/application`

The endpoint is built, tested and deployed to both workers. The form was
trimmed to match `APPLICATION_FIELDS` exactly — `validateApplication()` rejects
unknown fields, so the shapes already line up, including the `zip` field the
form was missing.

`start.html` still posts to **Formspree**. Payment → verification is still
manual.

### 5. Admin: render the trade picker

`GET /api/admin/vetting/:id/preview` now returns `trade_options` — the 16
values `PATCH .../profile` accepts. The admin UI still shows a free-text box.

The constraint is enforced server-side either way (`bb7630f`), so this is
ergonomics, not correctness. A `textos-web` change.

### 6. `--dim-text` and the star gold fail WCAG AA

Measured, not estimated:

| Token | On white | Needs | Used for |
|---|---|---|---|
| `--dim-text` `#8B96A3` | **3.00:1** | 4.5:1 | `.dti-note`, captions throughout |
| star gold `#D08700` | **2.94:1** | 4.5:1 | `.rating` stars |

The directory surfaces work around both — `--steel` (5.46) for captions and
`#9A6100` (5.14) for stars — but `site.css` still uses the failing values
everywhere else. Fixing them at the token level would lift every page at once.

### 7. Badge SVGs hardcode `VERIFIED 2026`

All six variants (`compact`, `horizontal`, `square` × light/dark) carry the
year in the artwork **and** in the `aria-label`. The API returns
`verified_year` per business.

Accurate for every current record. Wrong the day a 2027 verification
publishes, and it fails silently — the card renders, the year is just a lie.
Needs a year-less variant or per-year assets. A design decision.

### 8. Test and prod share the `SNAPSHOT_KV` namespace

`wrangler.toml` binds namespace id `198fb2847eaa45f9b9d3102311832b9b` at both
the top level (prod) and under `[env.test]`. Rate-limit counters therefore
collide across environments — test traffic can consume prod's window.

Harmless for what it is (a coarse abuse brake that fails open), but it means
the two environments are not as isolated as the rest of the config implies.

### 9. `google_profile` is null on every live record

The column exists (migration 131 applied) and the profile endpoint publishes
it. No row has a value, so the "On Google" row never renders. Data, not code.

---

## DONE

### Trade vocabulary — closed

**Correcting the original diagnosis in this file.** It previously recorded
verified rows carrying `electrician` while unvetted carried `Electrician`, and
called it a case-collision like the parish one. **That was wrong.** It was
inferred from API output, where `shapeUnvetted()` title-cases at render time.
All 15,822 rows are lowercase with zero case variants; `ilike` was never the
problem.

The real problems were vocabulary and scope, and both are fixed:

- **Scope.** Only 4,151 of 15,822 scraped rows are home-repair trades. The
  other 11,671 were dentists, salons, lawyers, gyms and car washes appearing
  in a directory that calls them contractors. The unvetted tier is now
  restricted to 16 categories (`HOME_TRADE_CATEGORIES`). Unvetted dropped from
  15,818 to 4,147; pages at 50/row from 317 to 83.
- **Vocabulary.** The filter is a case-insensitive *equals*, so `trade=roofer`
  matched nothing — the stored value is `roofing contractor`. ~70 synonyms now
  map what a family types to what is stored. `roofer` → 299, `ac` → 359,
  `handyman` → 734, `mover` → 437, all previously 0. Unmapped input passes
  through, so an exact category still matches.
- **Drift.** The curated `trade` on a verified record was free text and could
  diverge from the filter's vocabulary, failing silently — the business simply
  never appeared for its own trade. `PATCH /api/admin/vetting/:id/profile` now
  canonicalises against the same constant and refuses anything outside it.

`75662df`, `bb7630f`.

### `q` searched `trading_name` only — closed

A verified business whose card showed a name resolved from `legal_name` could
not be found by searching the name it displayed. Now searches `trading_name`,
`legal_name` and `name` — the same three, in the same order, that
`displayName()` resolves. `75662df`.

### Contractor profile pages — closed

`/contractor/{slug}`, served by a `_redirects` rewrite onto `listing.html`.
Full badge, contact block, the nine confirmations, and all five DTI pillars.
404 is identical for unverified, unpublished and expired, so a failed
verification stays unidentifiable. On the preview; ships with item 2.

Two Cloudflare Pages behaviours are load-bearing and documented in
`_redirects`: the shell cannot be named `contractor.html` (clean-URL
normalisation 308s `/contractor/*` to `/contractor`), and the rewrite target
cannot end in `.html` (normalised to a 308 instead of a rewrite).

### Business contact on the public profile — closed

`GET /api/contractor/:slug` publishes phone, website, Google profile and full
address. Profile only — never `/featured` or `/search`, which return up to 75
records per request and would become a bulk-harvestable phone list.

Permanently internal on every endpoint: `contact_email`, `contact_name`,
`phone_e164_digits`, `license_number`, `gl_carrier`, check notes. `2e454a2`.
