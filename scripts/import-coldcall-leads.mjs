// Importer: a LeadScout-shaped CSV export -> public.coldcall_leads
//
// Run from the repo root:
//   node scripts/import-coldcall-leads.mjs                              # dry run, Louisiana profile
//   node scripts/import-coldcall-leads.mjs --confirm                    # actually insert
//
//   node scripts/import-coldcall-leads.mjs \
//     --file coldcall_leads_gulf_coast.csv --profile gulf-coast --append
//
//   node scripts/import-coldcall-leads.mjs --profile al-fl --append --dry-run \
//     --file coldcall_leads_alabama.csv --file coldcall_leads_florida.csv
//   ... then the same command with --confirm to write.
//
// Flags:
//   --file <path>        CSV to read. REPEATABLE - pass it once per file and
//                        they load as ONE run, which is what lets duplicate
//                        place_ids ACROSS files be caught.
//                        Default: victora_leads_database.csv
//   --profile <name>     Field-mapping profile: louisiana (default) | gulf-coast
//   --append             Preflight becomes a per-place_id collision check
//                        instead of "the table must be empty".
//   --dry-run            Explicit no-write. (Dry run is ALREADY the default;
//                        this flag exists so it can be stated, and it refuses
//                        to run alongside --confirm.)
//   --confirm            Actually insert.
//
// Reads the CSV IN PLACE. The file is third-party prospect PII and is
// gitignored; it is never copied, never committed, and the script writes
// nothing back to disk.
//
// Connects with the same credentials the Worker uses — SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY out of .dev.vars (gitignored). The service role
// bypasses RLS, which is required here: coldcall_* is deny-by-default and has
// no policy that would let anon or authenticated write.
//
// ── THE BLANK-vs-FALSE RULE ──────────────────────────────────────────
// Only 1,000 of the 15,822 Louisiana leads were enriched. For every
// enrichment boolean:
//     blank            -> NULL   ("we did not look")
//     "none detected"  -> false  ("we looked, nothing there")
//     TRUE / a vendor  -> true   ("we looked, it is there")
// NULL and false are different facts and are never collapsed. Writing false
// where we mean NULL would claim we verified 15,313 businesses we never
// probed.
//
// ── WHY PROFILES EXIST ───────────────────────────────────────────────
// The Gulf Coast export (2026-10) ships the SAME 47 column names as the
// Louisiana one, reordered, but two of them mean different things:
//
//   category      LA: the normalised human name ('hvac contractor')
//                 Gulf: a SLUG ('hvac') that exists nowhere in the system
//   category_raw  LA: the raw Google string
//                 Gulf: the human name ('HVAC contractor')
//
// The two columns have swapped roles. Loading Gulf's `category` would poison
// the vocabulary that coldcall_hero_map, the demo pipeline and the public
// directory all read. Three more Gulf fields are not what their LA
// counterparts were either (parish, enrichment_status, has_website).
//
// So the mapping is a PROFILE, and 'louisiana' is byte-for-byte the behaviour
// this script had before profiles existed. A new regional export gets a new
// profile entry, never an edit to an existing one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
// The AL/FL category table. Imported rather than inlined so the mapping Rob
// approved in the pre-load report and the values actually written are the same
// data. See scripts/al-fl-category-map.mjs.
import { PAIR_MAP, pairKey } from "./al-fl-category-map.mjs";
// The home-trade allow-list, so the trade / non-trade split in the report is
// the same set that gates slugs, Places and the public directory - not a
// second opinion about what counts as a trade.
import { HOME } from "./bulk-enrich/home-trades.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BATCH = 500;
const PAGE = 1000;

// ── flags ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CONFIRM = argv.includes("--confirm");
const DRY_RUN = argv.includes("--dry-run");
const APPEND = argv.includes("--append");
const PROFILE_NAME = flagValue("--profile") ?? "louisiana";
// --file is REPEATABLE. The AL/FL import ships as two files that must load as
// one run so cross-file duplicate place_ids can be caught (11 of them are in
// both), which a file-at-a-time loop could not see.
const fileArgs = argv.map((a, i) => (a === "--file" ? argv[i + 1] : null)).filter(Boolean);
const FILES = (fileArgs.length ? fileArgs : ["victora_leads_database.csv"])
  .map((f) => path.resolve(ROOT, f));

function die(msg) {
  console.error(`\n  HALT: ${msg}\n`);
  process.exit(1);
}

if (DRY_RUN && CONFIRM) {
  die("--dry-run and --confirm contradict each other. Pass one or neither.");
}

// ── credentials, from .dev.vars (never printed) ──────────────────────
function loadDevVars() {
  const p = path.join(ROOT, ".dev.vars");
  if (!fs.existsSync(p)) die(`missing ${p} — cannot connect to Supabase`);
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  // .dev.vars currently stores SUPABASE_URL WITH the REST path already on it
  // ("https://<ref>.supabase.co/rest/v1/"). supabase-js appends its own, which
  // yields /rest/v1/rest/v1/<table> and a PGRST125 "Invalid path" on every
  // query. Normalize to the bare origin so this works with either form.
  if (out.SUPABASE_URL) {
    out.SUPABASE_URL = out.SUPABASE_URL.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  }
  return out;
}

function connect() {
  const env = loadDevVars();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    die(".dev.vars is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// ── RFC4180 parser: quoted fields, "" escapes, embedded commas/newlines ──
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;              // CRLF
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── field coercions ──────────────────────────────────────────────────
const s = (v) => { const t = (v ?? "").trim(); return t === "" ? null : t; };

const int = (v, col, rowNo) => {
  const t = s(v);
  if (t === null) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) die(`row ${rowNo}: ${col} is not a number: ${t}`);
  return Math.trunc(n);
};

const num = (v, col, rowNo) => {
  const t = s(v);
  if (t === null) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) die(`row ${rowNo}: ${col} is not a number: ${t}`);
  return n;
};

// TRUE / FALSE / blank -> true / false / null. Anything else halts.
const bool = (v, col, rowNo) => {
  const t = (v ?? "").trim().toUpperCase();
  if (t === "") return null;
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  die(`row ${rowNo}: ${col} is not a boolean: ${v}`);
};

// Vendor columns: blank -> null (not checked), "none detected" -> false,
// anything else (a vendor list like ["CallRail"]) -> true.
const vendorBool = (v) => {
  const t = (v ?? "").trim();
  if (t === "") return null;
  return t.toLowerCase() !== "none detected";
};

const ts = (v, col, rowNo) => {
  const t = s(v);
  if (t === null) return null;
  if (Number.isNaN(Date.parse(t))) die(`row ${rowNo}: ${col} is not a timestamp: ${t}`);
  return t;
};

// ── profiles ─────────────────────────────────────────────────────────
/**
 * A profile may override the mapping of individual columns and may exclude
 * whole rows. Anything it does not override keeps the Louisiana behaviour.
 *
 * `category_of` is the one override every profile should think about: it is
 * what coldcall_hero_map, the demo pipeline and HOME_TRADE_CATEGORIES all key
 * on, and `trade` is set from its result.
 */

/**
 * Gulf Coast aliases, from the import brief.
 *
 * Three of the file's trade names are naming variants of categories that
 * already exist. Loading them verbatim would create a second spelling of a
 * trade we already have a hero folder and a public filter for, which is the
 * silent-invisibility bug the public vocabulary module exists to prevent.
 * Everything else keeps its lowercased category_raw.
 */
const GULF_ALIASES = {
  "gutter installation": "gutter service",
  "fencing contractor": "fence contractor",
  "air conditioning repair": "hvac contractor",
};

const PROFILES = {
  louisiana: {
    label: "Louisiana (victora-leadscout, 2026-08)",
    columns: 47,
    // The original behaviour, unchanged.
    category_of: (g, r) => s(g(r, "category")),
    overrides: () => ({}),
    excludeRow: () => null,
  },

  "gulf-coast": {
    label: "Gulf Coast (FL/AL/MS, 2026-10)",
    columns: 47,

    // `category_raw` holds the human name here; `category` holds a slug that
    // exists nowhere in the system. Lowercase, then alias.
    category_of: (g, r) => {
      const raw = s(g(r, "category_raw"));
      if (raw === null) return null;
      const lc = raw.toLowerCase();
      return GULF_ALIASES[lc] ?? lc;
    },

    overrides: (g, r, rowNo, notes) => {
      // parish: the file holds the MARKET'S ANCHOR COUNTY, not the business's
      // own county, and the nine values are mechanically 1:1 with market. It
      // would also read as wrong in an admin dropdown full of Louisiana
      // parishes. Load nothing rather than something misleading.
      const out = { parish: null };

      // The file's own category slug is kept verbatim in category_raw's place
      // only if we wanted it; we do not. category_raw keeps the human name,
      // which is what it holds in this export.
      out.category_raw = s(g(r, "category_raw"));

      // enrichment_status: the file says 'scraped', which is not one of the
      // five values the CHECK constraint permits — and it would be a lie
      // either way. Nobody probed these sites. 'not_enriched' is the value
      // that means exactly that, and it is what keeps the DTI scorer
      // returning NULL rather than a 0 built from our own missing record.
      out.enrichment_status = "not_enriched";

      // Tag the batch so every post-import pass can be scoped to it and so
      // these rows stay identifiable forever.
      out.enrichment_wave = "gulf-coast-2026-10";

      // has_website: TRUE where the scrape found a URL, NULL otherwise —
      // never FALSE. A FALSE here would claim we checked for a site and found
      // none, which is precisely the false-vs-null mistake that had to be
      // reverted across 14,820 rows once already. Verified in recon: this
      // column is a perfect mirror of website_url presence, 0 mismatches.
      out.has_website = s(g(r, "website_url")) !== null ? true : null;

      // rank: NULL. The file's 1..2,585 is an ordering WITHIN this file and
      // would collide with 2,585 live ranks produced by a different scoring
      // run. NULL is the honest value and every rank sort already handles it
      // (nullsFirst:false throughout trustlight-vetting.ts).
      out.rank = null;

      // phone_e164_digits: one row carries a 12-digit value. The column is
      // TEXT so it would load silently; a phone number that is not a phone
      // number is worse than a blank, so it becomes NULL. `phone` is kept
      // exactly as the file has it either way.
      const e164 = s(g(r, "phone_e164_digits"));
      if (e164 !== null && !/^\d{10,11}$/.test(e164)) {
        out.phone_e164_digits = null;
        notes.badE164.push({ rowNo, name: s(g(r, "business_name")), value: e164 });
      }

      return out;
    },

    // FL/AL/MS only. The file carries 23 LA and 5 GA rows; LA is already
    // covered by the original import and GA is outside the campaign.
    excludeRow: (g, r) => {
      const st = (s(g(r, "state")) ?? "").toUpperCase();
      if (st === "LA" || st === "GA") return `state ${st}`;
      return null;
    },
  },

  "al-fl": {
    label: "Alabama + Florida (26-column, 2026-10)",

    // A DIFFERENT SHAPE, not a reordering: 26 columns against the other two
    // profiles' 47. It drops score_category_source, is_cap_demoted, both
    // enrichment_* columns and every website-check column, and it renames
    // parish -> county. Nothing special is needed for the dropped ones: an
    // absent column reads as undefined, which every coercion turns into NULL.
    columns: 26,

    // category_raw here is a MIX of Google type names (roofing_contractor,
    // car_repair) and human names (tile contractor, lawn care), and `category`
    // is a slug that exists nowhere in the system. Neither column alone is the
    // stored vocabulary, so the mapping is an explicit table keyed on the PAIR.
    //
    // Keyed on the pair and not the slug because two slugs carry two raws each:
    //   hvac     -> "HVAC contractor" AND "air conditioning repair"
    //   flooring -> "flooring contractor" AND "tile contractor"
    // Mapping by slug alone would fold 97 tile contractors into flooring.
    //
    // No-fallbacks: an unmapped pair HALTS. A guessed category would silently
    // create a vocabulary the hero map and the public directory do not know.
    category_of: (g, r) => {
      const key = pairKey(g(r, "category"), g(r, "category_raw"));
      const hit = PAIR_MAP[key];
      if (!hit) {
        die(`unmapped category pair: category='${s(g(r, "category"))}' ` +
            `category_raw='${s(g(r, "category_raw"))}' ` +
            `(row ${r.rowNo} of ${r.file}). Add it to scripts/al-fl-category-map.mjs.`);
      }
      return hit.to;
    },

    overrides: (g, r, rowNo, notes) => {
      const out = {};

      // parish <- county. This export's county IS the county the business was
      // searched in, and the spot check holds: city matches county for all but
      // ~582 metro-edge rows (Birmingham searched under Shelby, Tampa under
      // Pasco). Those are real adjacency, not errors, so the file's value is
      // loaded as given and the spillover is REPORTED rather than corrected.
      //
      // Note this is the opposite call from the Gulf profile, which loaded NULL
      // because its "parish" was the market's anchor county rather than the
      // business's own. Here the column means what the target column means.
      out.parish = s(g(r, "county"));

      // Nobody probed these sites. 'not_enriched' is the value that says so,
      // and it is what keeps the DTI scorer returning NULL instead of a 0 built
      // out of our own missing record.
      out.enrichment_status = "not_enriched";
      out.enrichment_wave = "al-fl-2026-10";

      // TRUE where the scrape found a URL, NULL otherwise - never FALSE.
      // Verified on the files: has_website mirrors website_url exactly, 0
      // mismatches both ways, so FALSE here would be our record's silence
      // dressed up as a checked absence.
      out.has_website = s(g(r, "website_url")) !== null ? true : null;

      // rank NULL. The file's values are an ordering WITHIN this export and
      // would collide with live ranks from other scoring runs. Every rank sort
      // uses nullsFirst:false, so NULL sorts last in both directions.
      out.rank = null;

      // 10 rows carry an extension or an international number here
      // (a US number with an "ext. NN" suffix -> 13 digits, +91 ..., +27 ...).
      // TEXT so they would load silently; a phone number that is not one is
      // worse than a blank. `phone` is kept exactly as the file has it.
      const e164 = s(g(r, "phone_e164_digits"));
      if (e164 !== null && !/^\d{10,11}$/.test(e164)) {
        out.phone_e164_digits = null;
        notes.badE164.push({ rowNo, name: s(g(r, "business_name")), value: e164 });
      }

      return out;
    },

    // AL and FL only. 20 rows carry GA, CT, TX, OR, IN or IL - mostly genuine
    // border businesses (Columbus GA under Lee County AL) plus a few that are
    // plainly mis-geocoded (a Connecticut Ulta under Jefferson County).
    excludeRow: (g, r) => {
      const st = (s(g(r, "state")) ?? "").toUpperCase();
      if (st !== "AL" && st !== "FL") return `state ${st || "(blank)"}`;
      return null;
    },
  },
};

const profile = PROFILES[PROFILE_NAME];
if (!profile) {
  die(`unknown --profile '${PROFILE_NAME}'. Known: ${Object.keys(PROFILES).join(", ")}`);
}

// ── read + parse ─────────────────────────────────────────────────────
console.log(`  profile : ${PROFILE_NAME} — ${profile.label}`);
console.log(`  mode    : ${APPEND ? "APPEND (per-place_id collision check)" : "FIRST LOAD (table must be empty)"}`);

// Each entry carries its own header index, so the files are NOT required to
// share a column ORDER - only a column count and the required names.
const body = [];
for (const f of FILES) {
  if (!fs.existsSync(f)) die(`missing ${f}`);
  const rows = parseCsv(fs.readFileSync(f, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const fileBody = rows.slice(1).filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
  console.log(`  file    : ${path.basename(f)}  columns ${header.length}  rows ${fileBody.length.toLocaleString()}`);
  if (header.length !== profile.columns) {
    die(`${path.basename(f)}: profile '${PROFILE_NAME}' expects the ${profile.columns}-column export, got ${header.length}`);
  }
  // Indexed BY NAME, so a reordered export needs no change here. The Gulf file
  // ships the same 47 names in a different order and loads because of this.
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const req of ["place_id", "business_name", "sales_ready_score", "is_callable"]) {
    if (!(req in idx)) die(`${path.basename(f)}: header is missing required column '${req}'`);
  }
  fileBody.forEach((r, i) => body.push({ r, idx, file: path.basename(f), rowNo: i + 2 }));
}
console.log(`  rows    : ${body.length.toLocaleString()} across ${FILES.length} file(s)`);

// A column ABSENT from a shape yields undefined here, which every coercion
// turns into NULL. That is how the 26-column AL/FL export runs the same
// mapping as the 47-column one without a special case per missing column.
const g = (e, name) => e.r[e.idx[name]];

// ── collision set (append mode only) ─────────────────────────────────
// Read BEFORE mapping so the dry run can report exactly what it would skip.
let db = null;
const existingPlaceIds = new Set();
if (APPEND) {
  db = connect();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("coldcall_leads")
      .select("place_id")
      .not("place_id", "is", null)
      .order("place_id")
      .range(from, from + PAGE - 1);
    if (error) die(`collision preflight failed: ${error.message}`);
    for (const r of data) existingPlaceIds.add(r.place_id);
    if (data.length < PAGE) break;
  }
  console.log(`  existing place_ids in coldcall_leads: ${existingPlaceIds.size.toLocaleString()}`);
}

// ── map ──────────────────────────────────────────────────────────────
const notes = { badE164: [], skippedCollision: [], skippedExcluded: [], mismatches: [],
                skippedDupe: [], perFile: new Map() };
const records = [];
const seenInRun = new Map(); // place_id -> the entry that claimed it

for (const r of body) {
  const rowNo = r.rowNo;
  notes.perFile.set(r.file, (notes.perFile.get(r.file) ?? 0) + 1);

  const placeId = s(g(r, "place_id"));
  const name = s(g(r, "business_name"));

  // ── skips, evaluated before any coercion so an excluded row can never
  // halt the run on a field we were never going to load ──
  const excluded = profile.excludeRow(g, r);
  if (excluded) {
    notes.skippedExcluded.push({ rowNo, name, placeId, reason: excluded, state: s(g(r, "state")) });
    continue;
  }
  // ORDER MATTERS, for the REPORT rather than the result.
  //
  // Cross-file dedupe is tested BEFORE the DB-collision check. With the checks
  // the other way round, a business present in both files that is ALSO already
  // in coldcall_leads got reported only as a collision, and the fact that the
  // two source files overlap at all stayed invisible - which is exactly what
  // happened on the first AL/FL dry run: 11 real cross-file duplicates showed
  // as 0, because all 11 are Dothan-market rows the Gulf import already loaded.
  //
  // The rows written are identical either way: a duplicate whose survivor then
  // collides is still dropped, one line further down.
  //
  // The first occurrence wins; the second is reported, never merged - merging
  // would mean picking between two source rows with no rule for which field is
  // righter.
  if (placeId !== null && seenInRun.has(placeId)) {
    const first = seenInRun.get(placeId);
    notes.skippedDupe.push({ rowNo, name, placeId, file: r.file, keptFrom: first.file, keptRow: first.rowNo });
    continue;
  }
  if (placeId !== null) seenInRun.set(placeId, r);

  if (APPEND && placeId !== null && existingPlaceIds.has(placeId)) {
    notes.skippedCollision.push({ rowNo, name, placeId, file: r.file });
    continue;
  }

  // No-fallbacks: call_score is the worklist sort key. A scoreless row would
  // sort unpredictably and get called in the wrong order, so halt instead.
  const score = num(g(r, "sales_ready_score"), "sales_ready_score", rowNo);
  if (score === null) die(`row ${rowNo}: sales_ready_score is blank — refusing to load a scoreless lead`);

  if (name === null) die(`row ${rowNo}: business_name is blank`);

  // callable is NOT NULL in the table; the file has zero blanks, but guard.
  const callable = bool(g(r, "is_callable"), "is_callable", rowNo);
  if (callable === null) die(`row ${rowNo}: is_callable is blank`);

  // The category the whole system keys on, per profile.
  const category = profile.category_of(g, r);

  const row = {
    // ── core (migration 115) ──
    place_id:   placeId,                    // blank -> NULL, permitted by the partial unique index
    name,
    phone:      s(g(r, "phone")),
    address:    s(g(r, "address")),
    category,
    category_raw: s(g(r, "category_raw")),
    parish:     s(g(r, "parish")),
    market:     s(g(r, "market")),
    rating:     num(g(r, "rating"), "rating", rowNo),   // blank -> NULL, never 0
    review_count: int(g(r, "review_count"), "review_count", rowNo), // a real 0 stays 0
    call_score: score,                                   // <- sales_ready_score
    callable,
    opening_angle: s(g(r, "opening_angle")),
    // assigned_to deliberately omitted -> NULL. Assignment happens in the UI.
    // status omitted -> DB default 'new'.
    // adoption_mindset / digital_gap / address_flag omitted -> NULL.

    // trade mirrors category from the moment the row is born.
    //
    // Migration 134 exists because it did not: the public unvetted tier reads
    // `category` and the verified tier reads `trade`, so verifying a business
    // moved it from a populated column to an empty one and made it LESS
    // visible. That hit four paying businesses. Setting both here means the
    // latent version of that bug is never created in the first place, and 134
    // (WHERE trade IS NULL) stays a no-op.
    trade: category,

    // ── ranking audit (116) ──
    rank:                  int(g(r, "rank"), "rank", rowNo),   // from the file, never recomputed
    is_unrated:            bool(g(r, "is_unrated"), "is_unrated", rowNo),
    score_category:        num(g(r, "score_category"), "score_category", rowNo),
    score_review:          num(g(r, "score_review"), "score_review", rowNo),
    score_rating:          num(g(r, "score_rating"), "score_rating", rowNo),
    score_category_source: s(g(r, "score_category_source")),
    is_cap_demoted:        bool(g(r, "is_cap_demoted"), "is_cap_demoted", rowNo),

    // ── location detail (116) ──
    city:              s(g(r, "city")),
    state:             s(g(r, "state")),
    zip:               s(g(r, "zip")),
    phone_e164_digits: s(g(r, "phone_e164_digits")),
    business_status:   s(g(r, "business_status")),

    // ── enrichment status (116) ──
    enrichment_status: s(g(r, "enrichment_status")),
    enrichment_wave:   s(g(r, "enrichment_wave")),
    enriched_at:       ts(g(r, "enriched_at"), "enriched_at", rowNo),

    // ── enrichment booleans — blank stays NULL (116) ──
    has_website:         bool(g(r, "has_website"), "has_website", rowNo),
    has_schema_org:      bool(g(r, "has_schema_org"), "has_schema_org", rowNo),
    recently_registered: bool(g(r, "recently_registered"), "recently_registered", rowNo),
    hijack_flag:         bool(g(r, "hijack_flag"), "hijack_flag", rowNo),
    chat_widget:         vendorBool(g(r, "chat_widget")),
    ai_voice_agent:      vendorBool(g(r, "ai_voice_agent")),
    booking_tool:        vendorBool(g(r, "booking_tool")),
    call_tracking:       vendorBool(g(r, "call_tracking")),
    analytics_pixels:    vendorBool(g(r, "analytics_pixels")),

    // ── vendor detail behind those booleans ──
    chat_widget_detail:      s(g(r, "chat_widget")),
    ai_voice_agent_detail:   s(g(r, "ai_voice_agent")),
    booking_tool_detail:     s(g(r, "booking_tool")),
    call_tracking_detail:    s(g(r, "call_tracking")),
    analytics_pixels_detail: s(g(r, "analytics_pixels")),

    // ── site + domain detail (116) ──
    website_url:          s(g(r, "website_url")),
    site_state:           s(g(r, "site_state")),
    site_http_status:     int(g(r, "site_http_status"), "site_http_status", rowNo),
    platform:             s(g(r, "platform")),
    domain:               s(g(r, "domain")),
    domain_registered_on: ts(g(r, "domain_registered_on"), "domain_registered_on", rowNo),
    domain_age_days:      int(g(r, "domain_age_days"), "domain_age_days", rowNo),
    domain_registrar:     s(g(r, "domain_registrar")),
    hijack_reason:        s(g(r, "hijack_reason")),
    signal_confidence:    s(g(r, "signal_confidence")),
  };

  // Profile overrides land last, so they always win over the base mapping.
  Object.assign(row, profile.overrides(g, r, rowNo, notes));

  // No-fallbacks: category is load-bearing. coldcall_hero_map keys on it and
  // resolveHeroFolder() treats an unmapped value as a seeding bug, so a NULL
  // here would produce a lead that can never get a demo.
  if (row.category === null) {
    die(`row ${rowNo}: category resolved to NULL (profile '${PROFILE_NAME}') — refusing to load an uncategorised lead`);
  }

  records.push(row);
}

// ── state/market coherence (report only, never a skip) ───────────────
// Rob reviews these by hand. The modal state per market is the reference:
// a market is a media market, so the state most of its rows carry is what it
// is, and the rest are worth a look without being wrong enough to drop.
{
  const byMarket = new Map();
  for (const r of records) {
    if (!r.market) continue;
    if (!byMarket.has(r.market)) byMarket.set(r.market, new Map());
    const m = byMarket.get(r.market);
    m.set(r.state, (m.get(r.state) ?? 0) + 1);
  }
  const modal = new Map();
  for (const [market, states] of byMarket) {
    modal.set(market, [...states].sort((a, b) => b[1] - a[1])[0][0]);
  }
  for (const r of records) {
    if (r.market && r.state && modal.get(r.market) !== r.state) {
      notes.mismatches.push({ name: r.name, state: r.state, market: r.market, expected: modal.get(r.market) });
    }
  }
}

// ── mapped-data summary, printed before anything is written ──────────
const count = (fn) => records.filter(fn).length;
const tally = (fn) => {
  const m = new Map();
  for (const r of records) { const k = fn(r); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
};

console.log(`\n  ROWS PER FILE`);
for (const [f, n] of notes.perFile) console.log(`    ${f.padEnd(34)} ${n.toLocaleString()}`);

console.log(`\n  SKIPPED`);
console.log(`    excluded by profile   : ${notes.skippedExcluded.length}`);
console.log(`    cross-file duplicates : ${notes.skippedDupe.length}`);
console.log(`    place_id collisions   : ${notes.skippedCollision.length}`);
// Each skipped row lands in exactly ONE bucket, in the order the checks run
// (excluded -> cross-file duplicate -> DB collision), so the subtraction below
// never double-counts. These two lines make the overlaps visible, because a raw
// place_id comparison against the DB will not agree with the collision count
// unless you know what was already taken out ahead of it.
const exclAlsoInDb = notes.skippedExcluded.filter((x) => x.placeId && existingPlaceIds.has(x.placeId)).length;
const dupeAlsoInDb = notes.skippedDupe.filter((x) => x.placeId && existingPlaceIds.has(x.placeId)).length;
console.log(`      excluded rows also in the DB   : ${exclAlsoInDb}  (counted under 'excluded')`);
console.log(`      duplicate rows also in the DB  : ${dupeAlsoInDb}  (counted under 'duplicates')`);
const totalSkipped = notes.skippedExcluded.length + notes.skippedDupe.length + notes.skippedCollision.length;
console.log(`    => ${body.length.toLocaleString()} - ${totalSkipped.toLocaleString()} = ${records.length.toLocaleString()} to load`);

if (notes.skippedCollision.length) {
  console.log(`\n  COLLISIONS (already in coldcall_leads — NOT touched)`);
  for (const x of notes.skippedCollision) console.log(`    row ${String(x.rowNo).padStart(5)}  ${String(x.name).slice(0, 40).padEnd(41)} ${x.placeId}`);
}
if (notes.skippedExcluded.length) {
  console.log(`\n  EXCLUDED BY PROFILE`);
  for (const x of notes.skippedExcluded) console.log(`    ${String(x.name).slice(0, 38).padEnd(39)} ${String(x.reason).padEnd(12)} ${x.file ?? ""}:${x.rowNo}`);
}
if (notes.skippedDupe.length) {
  console.log(`\n  CROSS-FILE DUPLICATES (first occurrence kept)`);
  for (const x of notes.skippedDupe) {
    console.log(`    ${String(x.name).slice(0, 38).padEnd(39)} dropped ${x.file}:${x.rowNo}  kept ${x.keptFrom}:${x.keptRow}`);
  }
}
if (notes.badE164.length) {
  console.log(`\n  MALFORMED phone_e164_digits -> NULL (phone column kept as-is)`);
  for (const x of notes.badE164) console.log(`    row ${String(x.rowNo).padStart(5)}  ${String(x.name).slice(0, 40).padEnd(41)} ${x.value}`);
}
if (notes.mismatches.length) {
  console.log(`\n  STATE / MARKET MISMATCHES (loaded anyway — for Rob's review): ${notes.mismatches.length}`);
  const grouped = new Map();
  for (const x of notes.mismatches) {
    const k = `${x.state} in ${x.market} (market is mostly ${x.expected})`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...grouped].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
}

console.log(`\n  MAPPED (pre-insert)`);
console.log(`    rows                  : ${records.length.toLocaleString()}`);
console.log(`    rating NULL           : ${count((r) => r.rating === null).toLocaleString()}`);
console.log(`    rating == 0           : ${count((r) => r.rating === 0)}   (must be 0)`);
console.log(`    is_unrated true       : ${count((r) => r.is_unrated === true).toLocaleString()}`);
console.log(`    callable true/false   : ${count((r) => r.callable).toLocaleString()} / ${count((r) => !r.callable).toLocaleString()}`);
console.log(`    phone NULL            : ${count((r) => r.phone === null).toLocaleString()}`);
console.log(`    place_id NULL         : ${count((r) => r.place_id === null)}`);
console.log(`    parish NULL           : ${count((r) => r.parish === null).toLocaleString()}`);
console.log(`    rank NULL             : ${count((r) => r.rank === null).toLocaleString()}`);
console.log(`    trade == category     : ${count((r) => r.trade === r.category).toLocaleString()} (must equal rows)`);
console.log(`    hijack_flag true      : ${count((r) => r.hijack_flag === true)}`);
console.log(`    has_website t/f/null  : ${count((r) => r.has_website === true).toLocaleString()} / ${count((r) => r.has_website === false)} / ${count((r) => r.has_website === null).toLocaleString()}`);
console.log(`    chat_widget n/f/t     : ${count((r) => r.chat_widget === null).toLocaleString()} / ${count((r) => r.chat_widget === false)} / ${count((r) => r.chat_widget === true)}`);
console.log(`    assigned_to set       : ${count((r) => "assigned_to" in r)} (must be 0)`);
console.log(`    enrichment_status     : ${JSON.stringify(tally((r) => r.enrichment_status ?? "(null)"))}`);
console.log(`    enrichment_wave       : ${JSON.stringify(tally((r) => r.enrichment_wave ?? "(null)"))}`);
console.log(`    by state              : ${JSON.stringify(tally((r) => r.state ?? "(null)"))}`);
console.log(`\n    by market`);
for (const [k, n] of tally((r) => r.market ?? "(null)")) console.log(`      ${String(k).padEnd(26)} ${n.toLocaleString()}`);
console.log(`\n    by category (post-alias — this is what hero_map must cover)`);
for (const [k, n] of tally((r) => r.category ?? "(null)")) console.log(`      ${String(k).padEnd(26)} ${n.toLocaleString()}`);

// ── trade vs non-trade ─────────────────────────────────
// These two groups get materially different downstream treatment, so the split
// is reported before anything is written:
//   home trades -> slug, Places lookup, enrichment probe, DTI, public listing
//   non-trades  -> none of that; hero folder 'generic'
// BOTH are callable, and both land in the Split-evenly pool and the /coldcall
// worklist, neither of which filters on category.
{
  const tradeRows = records.filter((r) => HOME.has(String(r.category).toLowerCase()));
  const nonRows = records.filter((r) => !HOME.has(String(r.category).toLowerCase()));
  const catsOf = (rows) => new Set(rows.map((r) => r.category)).size;
  console.log(`\n  TRADE vs NON-TRADE`);
  console.log(`    home trades : ${String(tradeRows.length.toLocaleString()).padStart(7)}  across ${catsOf(tradeRows)} categories`);
  console.log(`    non-trades  : ${String(nonRows.length.toLocaleString()).padStart(7)}  across ${catsOf(nonRows)} categories`);
  console.log(`    callable non-trades (these enter the split pool): ${nonRows.filter((r) => r.callable).length.toLocaleString()}`);
  if (nonRows.length) {
    console.log(`    top non-trade categories:`);
    const m = new Map();
    for (const r of nonRows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    for (const [k, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`      ${String(k).padEnd(26)} ${String(n.toLocaleString()).padStart(7)}`);
    }
  }
}

// ── county / parish spillover ─────────────────────────────
// Same technique as the state/market check: the reference is the MODAL parish
// for each (city, state) as the data itself reports it, so no external
// gazetteer is needed and no row is corrected. Loaded as given, reported for
// review - a metro that straddles a county line is real, not a defect.
{
  const byCity = new Map();
  for (const r of records) {
    if (!r.city || !r.state || !r.parish) continue;
    const k = `${String(r.city).toLowerCase()}|${r.state}`;
    if (!byCity.has(k)) byCity.set(k, new Map());
    const m = byCity.get(k);
    m.set(r.parish, (m.get(r.parish) ?? 0) + 1);
  }
  const modal = new Map();
  for (const [k, m] of byCity) modal.set(k, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  const spill = records.filter((r) => {
    if (!r.city || !r.state || !r.parish) return false;
    return modal.get(`${String(r.city).toLowerCase()}|${r.state}`) !== r.parish;
  });
  console.log(`\n  COUNTY / PARISH SPILLOVER (loaded as given, for review): ${spill.length.toLocaleString()}`);
  const amb = [...byCity.values()].filter((m) => m.size > 1).length;
  console.log(`    cities spanning more than one county: ${amb}`);
  const g2 = new Map();
  for (const r of spill) {
    const k = `${r.city}, ${r.state}: searched in ${r.parish}, mostly ${modal.get(`${String(r.city).toLowerCase()}|${r.state}`)}`;
    g2.set(k, (g2.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...g2].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(5)}x  ${k}`);
  }
  if (g2.size > 12) console.log(`    ... and ${g2.size - 12} more city/county combinations`);
}

// ── hero_map gate: every category must resolve, or demos fail ────────
// Checked in the DRY RUN too, because this is the precondition that migration
// 136 exists to satisfy. An unmapped category is a seeding bug by the time the
// demo pipeline sees it; better to fail here, before 2,536 rows are written.
if (db || APPEND || CONFIRM) {
  if (!db) db = connect();
  const { data: hm, error: hmErr } = await db.from("coldcall_hero_map").select("category");
  if (hmErr) die(`hero_map lookup failed: ${hmErr.message}`);
  const mapped = new Set(hm.map((h) => h.category));
  const unmapped = [...new Set(records.map((r) => r.category))].filter((c) => !mapped.has(c));
  console.log(`\n  HERO MAP GATE`);
  console.log(`    distinct categories to load : ${new Set(records.map((r) => r.category)).size}`);
  console.log(`    present in coldcall_hero_map: ${new Set(records.map((r) => r.category)).size - unmapped.length}`);
  if (unmapped.length) {
    console.log(`    MISSING: ${unmapped.join(", ")}`);
    die(`${unmapped.length} category/categories have no coldcall_hero_map row. ` +
        `Add a coldcall_hero_map row for each (the migration that accompanies this ` +
        `wave) and re-run — every one of these leads would fail demo generation.`);
  }
  console.log(`    all categories resolve ✓`);
}

if (!CONFIRM) {
  console.log(`\n  DRY RUN — nothing written. Re-run with --confirm to insert.\n`);
  process.exit(0);
}

// ── insert ───────────────────────────────────────────────────────────
if (!db) db = connect();

if (APPEND) {
  // The collision set was read at startup. Re-read the count only, as a
  // cheap guard against the table having changed under us since then.
  const { count: now, error: cErr } = await db
    .from("coldcall_leads").select("id", { count: "exact", head: true });
  if (cErr) die(`preflight count failed: ${cErr.message}`);
  console.log(`\n  append preflight: ${now.toLocaleString()} rows already present, ` +
              `${notes.skippedCollision.length} colliding place_ids skipped.`);
} else {
  // Refuse to double-load. In first-load mode this script inserts; it does not
  // upsert, so running it twice would duplicate every row that has no place_id
  // conflict. Pass --append to add to a populated table instead.
  const { count: existing, error: cErr } = await db
    .from("coldcall_leads").select("id", { count: "exact", head: true });
  if (cErr) die(`preflight count failed: ${cErr.message}`);
  if (existing !== 0) {
    die(`coldcall_leads already has ${existing.toLocaleString()} rows. ` +
        `Refusing to insert on top of existing data — pass --append to add to a ` +
        `populated table (per-place_id collision check), or clear the table first ` +
        `if a full reload is intended.`);
  }
}

console.log(`\n  inserting ${records.length.toLocaleString()} rows in batches of ${BATCH}...`);
let done = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const chunk = records.slice(i, i + BATCH);
  const { error } = await db.from("coldcall_leads").insert(chunk);
  if (error) die(`batch at record ${i + 1} failed: ${error.message}`);
  done += chunk.length;
  process.stdout.write(`\r    ${done.toLocaleString()} / ${records.length.toLocaleString()}`);
}
console.log(`\n  inserted ${done.toLocaleString()} rows.\n`);
