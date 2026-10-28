# Lead imports — the pipeline

How a regional lead export gets into `coldcall_leads` and ends up in the same
state as every other wave. Read this before importing anything.

The tooling lives here because `scripts/` is otherwise a scratch drawer. Only
the files listed in `.gitignore` under the `scripts/*` block are tracked; add a
`!` line for a new one rather than un-ignoring the directory.

**Lead CSVs are never committed.** They are third-party prospect PII (names,
phones, addresses). `victora_leads*.csv` and `coldcall_leads_*.csv` are
gitignored; drop a new export in the repo root and confirm `git check-ignore`
says so **before** reading it. Run checkpoints go to `%TEMP%`, not the repo.

---

## Run order

Every step is dry-run-first and scoped to one wave. Do them in this order.

```bash
# 0. confirm the file is ignored, THEN look at it
git check-ignore -v coldcall_leads_<region>.csv

# 1. dry run. Writes nothing. Halts if any category has no hero-map row.
node scripts/import-coldcall-leads.mjs --profile <profile> --append --dry-run \
  --file coldcall_leads_<region>.csv

# 2. apply the migration the dry run asks for (hero-map rows for new
#    categories), then re-run step 1 until the hero-map gate passes 100%.

# 3. load
node scripts/import-coldcall-leads.mjs --profile <profile> --append --confirm \
  --file coldcall_leads_<region>.csv

# 4. migration 134 re-verify — expect 0 rows. A no-op, because the importer
#    sets trade = category at insert. If it is NOT 0, something skipped it.

# 5. slugs: home trades only, fills blanks only
node scripts/bulk-enrich/slugs.mjs --plan
node scripts/bulk-enrich/slugs.mjs --run

# 6. Google Place Details for home trades with no website. COSTS MONEY —
#    $0.025/call. Always --plan first and get the number approved.
node scripts/bulk-enrich/places-run.mjs --plan --wave <wave>
node scripts/bulk-enrich/places-run.mjs --run  --wave <wave>

# 7. enrichment probe. ~0.9 rows/sec, so check the count before starting.
node scripts/bulk-enrich/run.mjs --plan --wave <wave> --trades-only
node scripts/bulk-enrich/run.mjs --run  --wave <wave> --trades-only

# 8. DTI scoring. No network, cheap, idempotent. Deliberately NOT --trades-only:
#    an unprobed non-trade is 'not_enriched', which is not scoreable anyway.
node scripts/bulk-enrich/run.mjs --score --wave <wave>

# 9. whole-directory verification
node scripts/bulk-enrich/verify-all.mjs
```

`parish-backfill.mjs` is **not** part of this order. It recovers city/state/
parish from the address for Louisiana rows only, against a hand-built
gazetteer. Run it only if a wave genuinely has no parish and the gazetteer
covers its state; it is dry-run by default and skips any row whose ZIP
disagrees with the mapping.

---

## Flags

| Flag | Script | What it does |
|---|---|---|
| `--file <path>` | importer | the CSV. **Repeatable** — several files load as ONE run, which is the only way duplicate `place_id`s *across* files get caught. |
| `--profile <name>` | importer | field mapping: `louisiana`, `gulf-coast`, `al-fl`. |
| `--append` | importer | preflight becomes a per-`place_id` collision check instead of "table must be empty". Required for every load after the first. |
| `--dry-run` / `--confirm` | importer | dry run is the default; `--confirm` writes. Passing both is refused. |
| `--wave <name>` | run.mjs, places-run.mjs | restricts **every read**, and therefore every write, to one import batch. Without it they read the whole table. |
| `--trades-only` | run.mjs | probe home-trade categories only. Affects the probe step, not `--score`. |
| `--plan` / `--run` / `--score` | run.mjs | classify only / enrich / DTI pass. |

---

## Rules

**Blank means unchecked.** The single most important rule. For every enrichment
boolean: blank → `NULL` ("we did not look"), `"none detected"` → `false` ("we
looked, nothing there"), a value → `true`. `NULL` and `false` are different
facts and are never collapsed. Writing `false` where we mean `NULL` once
claimed 14,820 businesses had been verified that nobody had looked at, and had
to be reverted. `has_website` is the usual trap: set it `true` where the scrape
found a URL and `NULL` otherwise — **never `false`**, unless Google was asked
about that specific business and said no.

**Never overwrite existing rows.** `--append` skips any `place_id` already in
`coldcall_leads` and reports it. Many collisions are live leads with call
history, assignments and statuses; an upsert would erase them. The importer
inserts, never upserts. Likewise `--wave` exists so a re-run cannot touch
earlier waves — confirm the earlier waves' counts are unchanged afterwards.

**`rank` is NULL for every new wave.** The file's rank is an ordering *within
that export* and would collide with live ranks from a different scoring run.
`NULL` is honest, and every rank sort uses `nullsFirst: false`, so unranked
rows sort last in both directions. Same reasoning as operator-created leads.

**`rating` blank stays NULL, never 0.** A business with no reviews is not a
business rated zero.

**No fallbacks.** A missing score, name or callable flag halts the run. An
unmapped category halts the run. A category with no `coldcall_hero_map` row
halts the run — an unmapped category is a seeding bug by the time the demo
pipeline sees it.

**`trade = category` at insert**, so the latent bug migration 134 cleaned up
(public unvetted reads `category`, verified reads `trade`) is never recreated.

**One home-trade vocabulary.** `scripts/bulk-enrich/home-trades.mjs` mirrors
`HOME_TRADE_CATEGORIES` in `src/lib/trustlight-public.ts`. If they disagree,
`src/` is right. Adding a trade means editing both, plus the two sets in
`e2e/e2e-trustlight-api.mjs`. Non-trades (restaurants, dentists, salons) are
deliberately **not** in it: they are callable cold-call leads only — hero folder
`generic`, no slug, no Places lookup, no DTI, no public listing.

**Non-trades are still in the call pool.** Neither the `/coldcall` worklist nor
hand assignment filters on category. Split evenly does, by default, since
`home_trades_only` defaults to true.

---

## Waves so far

| Wave | Profile | Loaded | Notes |
|---|---|---|---|
| (Louisiana, untagged) | `louisiana` | 15,822 | first load, 2026-08. 47-column export. |
| `gulf-coast-2026-10` | `gulf-coast` | 2,536 | of 2,585: −21 collisions, −28 LA/GA rows. |
| `al-fl-2026-10` | `al-fl` | 27,978 | of 28,562: −20 non-AL/FL, −11 cross-file dupes, −553 collisions. 6,968 trades / 21,010 non-trades. Enriched trades-only, 6,020 scored. |

Table total after all three: **46,341**.

### Profile differences, in one line each

- **`louisiana`** — 47 columns. The original behaviour; `category` is already
  the stored vocabulary.
- **`gulf-coast`** — 47 columns, reordered. `category` is a slug and
  `category_raw` is the human name: **the two columns swapped roles**. `parish`
  holds the market's anchor county rather than the business's, so it loads
  `NULL`. `enrichment_status` says `scraped`, which the CHECK rejects — loads
  `not_enriched`.
- **`al-fl`** — **26 columns**, a different shape: `county` instead of `parish`,
  no `score_category_source`, `is_cap_demoted`, `enrichment_*` or website-check
  columns. Absent columns resolve to `NULL` with no special-casing. Category is
  an explicit `(slug, category_raw)` → stored-category table in
  `al-fl-category-map.mjs`, keyed on the **pair** because two slugs carry two
  raws each (`hvac` → "HVAC contractor" *and* "air conditioning repair";
  `flooring` → "flooring contractor" *and* "tile contractor"). An unmapped pair
  halts.

---

## Things that bite

**`node` can abort with exit 127 and no error line.** On Node 24 / Windows a
run can die with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
src\win\async.c` and exit **127**. That is the runtime aborting, NOT "command
not found", and it swallows whatever was being printed. It killed the AL/FL
probe at 2,575 of 5,172. Two consequences:

- **A wrapper's exit code hides it.** `node run.mjs ... ; echo EXIT=$?` exits 0
  because the `echo` succeeded, so a background runner reports success. Check
  the script's own last line, not the shell's status.
- **Just re-run it.** The checkpoint (`%TEMP%/trustlight-bulk-enrich/done.jsonl`)
  means a resume reprobes nothing. AL/FL finished on the second pass with no
  duplicated work and no double writes.

**A degraded network turns the probe into an overnight job, silently.** The
AL/FL trades-only pass was estimated at ~1.6 h and took **20.6 h** for 2,577
rows: throughput decayed from 1.7/sec to ~0.03/sec and stayed there, because
there is no per-request timeout floor and no stall detector. The run keeps
crawling rather than failing, and the only symptom is the `/sec` figure in the
progress line. **Watch that number.** If it collapses by more than ~5x and
stays down, kill the run and restart later - the checkpoint makes that free.
Worth fixing before the next wave: a hard per-request timeout plus a throughput
floor that aborts.

**`run.mjs` dies on one bad write.** It used to `process.exit(1)` on any single
Supabase error; over a half-hour pass a transient `TypeError: fetch failed` is
near-certain, and it killed two runs at 4 and 60 rows. Every write now goes
through `writeWithRetry` — 3 attempts, 500ms/1500ms. It fires regularly and
recovers: 4 times on the AL/FL probe (`TypeError: fetch failed`) and once on the
score pass, where Supabase answered with an HTML **502 Bad Gateway** instead of
a JSON error — so a non-JSON body has to count as retryable too. A genuine
refusal still
exits non-zero, just later. **Reads are not covered**: `readAll` can still die
on a flaky connection. `--score` is idempotent, so just re-run it.

**`run.mjs` without `--trades-only` probes everything with a URL.** On the
AL/FL wave that was 21,374 rows (~6.5 h) against 5,172 (~1.6 h). Non-trades get
no public surface, so their enrichment columns would be measured and read by
nothing.

**Places Details hit rate is ~0% on exports that already carry websites.** Gulf:
1 of 708. AL/FL: 2 of 1,798. Both scrapes had already captured every URL they
had, so Google added nothing — but the run is still worth it, because it turns
"we have no URL" into a *sourced* `no_website_found`, which is the strongest
digital-gap signal in the table and the only honest route to `has_website=false`.

**Test and prod share one Supabase project.** There is no separate test
database. Anything these scripts write is live.

---

## Not in git

Deliberately: the lead CSVs, run checkpoints (`%TEMP%`), per-business snapshots
(`_kwik-*.json`), logs, and the ~40 one-off probe and diagnostic scripts in
`scripts/`. `enrich.mjs` and `dti.mjs` ARE tracked, because `run.mjs` will not
start without them — they are esbuild bundles of `src/lib/trustlight-enrich.ts`
and `src/lib/trustlight-dti.ts`. Regenerate from `src/`; never hand-edit.
