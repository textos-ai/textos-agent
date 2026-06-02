// factory-v2 — VENDOR-SCRIPT dependency registry + resolver (Part B).
//
// Closed, canonical registry (mirrors the design-token dictionary / font-pairing
// pattern). The ASSEMBLER derives the script set from the composed components;
// the LLM never picks scripts. No-fallbacks: an unknown dep id, or a component
// that needs a global SYMBOL the selected base bundle doesn't expose, THROWS at
// build time — turning silent runtime breakage (the Part-A radar) into a loud
// build error.
//
// Two kinds of registry entries:
//   - base-bundle CAPABILITY (in_base_bundle:true, src:null) — a global that
//     lives inside the base bundle files (vendors.min.js / app.js). It is NOT
//     loaded separately; it is VALIDATED against the base bundle's `provides`.
//     (This is the Part-A lesson: track exposed SYMBOLS, not just files.)
//   - add-on FILE (in_base_bundle:false, src set) — a separate script to load.
//
// `provides` = global symbols the script exposes. `requires` = other registry
// ids it needs (for load order + closure).

import { CATALOG } from './index';

export interface VendorScript {
  /** separate-file path under /homer/*, or null for a base-bundle capability. */
  src: string | null;
  /** true = code lives in the base bundle (validated, not loaded); false = add-on file. */
  in_base_bundle: boolean;
  /** global symbols this script exposes. */
  provides: string[];
  /** other vendor-script ids this depends on. */
  requires: string[];
}

export const VENDOR_SCRIPTS: Record<string, VendorScript> = {
  // ── base-bundle capabilities (live inside vendors.min.js / app.js) ─────────
  chartjs: { src: null, in_base_bundle: true, provides: ['Chart'], requires: [] }, // vendors.min.js
  'custom-chartjs': { src: null, in_base_bundle: true, provides: ['CustomChartJs', 'ins'], requires: ['chartjs'] }, // app.js (NOT app.mini.js)
  jquery: { src: null, in_base_bundle: true, provides: ['$', 'jQuery'], requires: [] }, // vendors.min.js
  bootstrap: { src: null, in_base_bundle: true, provides: ['bootstrap'], requires: [] }, // vendors.min.js
  flatpickr: { src: null, in_base_bundle: true, provides: ['flatpickr'], requires: [] }, // vendors.min.js (+ init in app.js Plugins)
  simplebar: { src: null, in_base_bundle: true, provides: ['SimpleBar'], requires: [] }, // vendors.min.js

  // ── add-on files (separate scripts, cross-referenced vendor folder ↔ demos) ─
  'form-wizard': { src: '/homer/js/pages/form-wizard.js', in_base_bundle: false, provides: ['FormWizard'], requires: ['bootstrap'] },
  // Custom TextOS helper: reactive input→output binding (the Calculator live-compute
  // engine). Self-inits via its own IIFE/DOMContentLoaded listener (independent of
  // app.js), exposing window.txBind. Add-on file — the assembler loads its src.
  'tx-bind': { src: '/homer/js/tx-bind.js', in_base_bundle: false, provides: ['txBind'], requires: [] },
  choices: { src: '/homer/plugins/choices/choices.min.js', in_base_bundle: false, provides: ['Choices'], requires: [] },
  'form-choice': { src: '/homer/js/pages/form-choice.js', in_base_bundle: false, provides: [], requires: ['choices'] },
  handlebars: { src: '/homer/plugins/handlebars/handlebars.min.js', in_base_bundle: false, provides: ['Handlebars'], requires: [] },
  typeahead: { src: '/homer/plugins/typeahead/typeahead.bundle.min.js', in_base_bundle: false, provides: ['Bloodhound'], requires: ['jquery'] },
  'form-typehead': { src: '/homer/js/pages/form-typehead.js', in_base_bundle: false, provides: [], requires: ['handlebars', 'typeahead'] },
  datatables: { src: '/homer/plugins/datatables/dataTables.min.js', in_base_bundle: false, provides: ['DataTable'], requires: ['jquery'] },
  'datatables-bs5': { src: '/homer/plugins/datatables/dataTables.bootstrap5.min.js', in_base_bundle: false, provides: [], requires: ['datatables', 'bootstrap'] },
  'datatables-responsive': { src: '/homer/plugins/datatables/dataTables.responsive.min.js', in_base_bundle: false, provides: [], requires: ['datatables'] },
  jszip: { src: '/homer/plugins/datatables/jszip.min.js', in_base_bundle: false, provides: ['JSZip'], requires: [] },
  pdfmake: { src: '/homer/plugins/datatables/pdfmake.min.js', in_base_bundle: false, provides: ['pdfMake'], requires: [] },
  sweetalert2: { src: '/homer/plugins/sweetalert2/sweetalert2.min.js', in_base_bundle: false, provides: ['Swal'], requires: [] },
};

export function isVendorScript(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(VENDOR_SCRIPTS, id);
}

export class UnknownVendorScriptError extends Error {
  constructor(id: string, declaredBy: string) {
    super(
      `factory-v2: "${id}" (declared by component "${declaredBy}") is not a known vendor script. ` +
        `Closed registry: ${Object.keys(VENDOR_SCRIPTS).join(', ')}. No fallback.`,
    );
    this.name = 'UnknownVendorScriptError';
  }
}

export class UnmetVendorDependencyError extends Error {
  constructor(
    public readonly scriptId: string,
    public readonly missingSymbols: string[],
    public readonly baseBundleId: string,
    public readonly neededByComponents: string[],
  ) {
    super(
      `factory-v2: component(s) [${neededByComponents.join(', ')}] need global symbol(s) ` +
        `[${missingSymbols.join(', ')}] via vendor script "${scriptId}", but the "${baseBundleId}" base ` +
        `bundle does not expose them. No fallback — the base bundle must provide these globals (this is ` +
        `exactly the CustomChartJs/app.mini.js case).`,
    );
    this.name = 'UnmetVendorDependencyError';
  }
}

export interface BaseBundle {
  id: string;
  /** the script files the document-shell ALWAYS loads, in order. */
  files: string[];
  /** the global symbols those files expose. */
  provides: string[];
}

/** Full bundle: vendors.min.js + the FULL app.js (exposes CustomChartJs/ins). */
export const BASE_BUNDLE_FULL: BaseBundle = {
  id: 'full',
  files: ['/homer/js/vendors.min.js', '/homer/js/app.js'],
  provides: ['Chart', 'CustomChartJs', 'ins', '$', 'jQuery', 'bootstrap', 'flatpickr', 'SimpleBar', 'debounce'],
};

/** Lean bundle: vendors.min.js + app.mini.js — CustomChartJs/ins are IIFE-private (NOT exposed). */
export const BASE_BUNDLE_MINI: BaseBundle = {
  id: 'mini',
  files: ['/homer/js/vendors.min.js', '/homer/js/app.mini.js'],
  provides: ['Chart', '$', 'jQuery', 'bootstrap', 'flatpickr', 'SimpleBar'],
};

/**
 * Derive the ordered add-on script list for a composition.
 * - collects the UNION of js_dependencies across the composed components,
 * - expands `requires` transitively,
 * - VALIDATES base-bundle capabilities against `base.provides` (throw if unmet),
 * - DROPS anything satisfied by the base bundle,
 * - topo-sorts the remaining add-ons by `requires`,
 * - returns the ordered `src` list.
 * Throws on an unknown dep id or an unmet base-bundle symbol (no silent skip).
 */
export function resolveVendorScripts(componentIds: string[], base: BaseBundle): string[] {
  const neededBy = new Map<string, Set<string>>(); // depId → component ids that (transitively) need it
  const add = (id: string, comp: string) => {
    if (!neededBy.has(id)) neededBy.set(id, new Set());
    neededBy.get(id)!.add(comp);
  };

  // 1. direct deps from each component (closed-set checked).
  const queue: string[] = [];
  for (const cid of componentIds) {
    const entry = CATALOG.by_id[cid];
    if (!entry) continue;
    for (const dep of entry.vendor_scripts ?? []) {
      if (!isVendorScript(dep)) throw new UnknownVendorScriptError(dep, cid);
      add(dep, cid);
      queue.push(dep);
    }
  }

  // 2. transitive closure via requires (propagating attribution for errors).
  const closure = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const req of VENDOR_SCRIPTS[id].requires) {
      if (!isVendorScript(req)) throw new UnknownVendorScriptError(req, id);
      for (const c of neededBy.get(id) ?? []) add(req, c);
      queue.push(req);
    }
  }

  // 3. classify: validate base capabilities, collect add-ons.
  const addOns: string[] = [];
  for (const id of closure) {
    const s = VENDOR_SCRIPTS[id];
    if (s.in_base_bundle) {
      const missing = s.provides.filter((sym) => !base.provides.includes(sym));
      if (missing.length > 0) {
        throw new UnmetVendorDependencyError(id, missing, base.id, [...(neededBy.get(id) ?? [])]);
      }
      // satisfied by base — not loaded separately.
    } else {
      addOns.push(id);
    }
  }

  // 4. topo-sort add-ons by their add-on requires (base reqs load first anyway).
  const addOnSet = new Set(addOns);
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (ordered.includes(id) || !addOnSet.has(id)) return;
    if (visiting.has(id)) return; // defensive (no cycles expected)
    visiting.add(id);
    for (const req of VENDOR_SCRIPTS[id].requires) if (addOnSet.has(req)) visit(req);
    visiting.delete(id);
    ordered.push(id);
  };
  for (const id of addOns) visit(id);

  return ordered.map((id) => VENDOR_SCRIPTS[id].src as string);
}
