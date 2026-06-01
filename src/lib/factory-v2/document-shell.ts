// factory-v2 — minimal document shell.
//
// The ONLY non-component HTML in this proof: a bare HTML document + the
// PRD §A.7 Bootstrap container frame. Everything INSIDE the container is
// composed from catalog component templates (see assemble.ts). The shell
// loads the real Homer bundle so the composed blocks render with true Homer /
// Bootstrap styling.
//
// THEME (Step B): the root <html> is stamped with the chosen Homer skin +
// light color-scheme — <html data-skin="{skin}" data-bs-theme="light">. Every
// catalog component inherits the palette via Homer's CSS variables; there is
// NO per-component theming. `skin` defaults to "default" so existing callers
// (the captured static proof pages) are byte-stable except for the added
// data-bs-theme="light" (light is the platform default — harmless).
//
// ASSET PATHS:
//   - Default (assetBase = '') → root-relative /homer/* paths. Correct when the
//     output is CAPTURED as a static file on the textos-web origin
//     (https://…/dev/*.html), where /homer/* resolves to public/homer/*. This
//     is the original behavior; the build-proof / build-live-proof / proof-route
//     callers rely on it and are unchanged.
//   - assetBase set (e.g. the live Worker route) → absolute URLs. A page served
//     LIVE from the Worker origin has no /homer/* of its own, so it must point
//     at the textos-web origin that does.

const HOMER_CSS = [
  '/homer/css/vendors.min.css',
  '/homer/css/app.min.css',
];

const HOMER_JS = [
  '/homer/js/vendors.min.js',
  '/homer/js/app.mini.js',
];

export interface WrapProofOptions {
  /** Homer skin id (default | two | three | four | five | six). Default 'default'. */
  skin?: string;
  /** Absolute origin to prefix /homer/* asset paths with (e.g. when served live
   *  from the Worker). Empty string → root-relative (captured-static default). */
  assetBase?: string;
  /** Extra script srcs to load AFTER the Homer bundle (e.g. form-wizard.js).
   *  /homer/* paths are prefixed with assetBase like the bundle. */
  extraScripts?: string[];
  /** Raw inline JS appended in a final <script> after all src scripts. */
  inlineScript?: string;
}

export function wrapProofDocument(innerHtml: string, opts: WrapProofOptions = {}): string {
  const skin = opts.skin ?? 'default';
  const base = opts.assetBase ?? '';
  const css = HOMER_CSS.map((href) => `<link rel="stylesheet" href="${base}${href}">`);
  const js = [...HOMER_JS, ...(opts.extraScripts ?? [])].map((src) => `<script src="${base}${src}"></script>`);

  return [
    '<!DOCTYPE html>',
    `<html lang="en" data-skin="${skin}" data-bs-theme="light">`,
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>factory-v2 — Strategy compose proof</title>',
    ...css,
    '</head>',
    '<body class="bg-body-tertiary">',
    // PRD §A.7 container frame — the only hand-written structural HTML.
    '<div class="container my-4" style="max-width:720px">',
    '<div class="d-flex flex-column gap-3">',
    innerHtml,
    '</div>',
    '</div>',
    ...js,
    ...(opts.inlineScript ? [`<script>${opts.inlineScript}</script>`] : []),
    '</body>',
    '</html>',
  ].join('\n');
}
