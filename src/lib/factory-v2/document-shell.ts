// factory-v2 — minimal document shell.
//
// The ONLY non-component HTML in this proof: a bare HTML document + the
// PRD §A.7 Bootstrap container frame. Everything INSIDE the container is
// composed from catalog component templates (see assemble.ts). The shell
// loads the real Homer bundle from the textos-web origin (relative /homer/
// paths) so the composed blocks render with true Homer / Bootstrap styling.
//
// Asset paths are root-relative because this page is served as a top-level
// document on the textos-web origin (https://…/dev/factory-strategy-proof.html),
// where /homer/* resolves to public/homer/* — unlike the agent's iframe-srcdoc
// path, which needs absolute URLs.

const HOMER_CSS = [
  '/homer/css/vendors.min.css',
  '/homer/css/app.min.css',
];

const HOMER_JS = [
  '/homer/js/vendors.min.js',
  '/homer/js/app.mini.js',
];

export function wrapProofDocument(innerHtml: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en" data-skin="default">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>factory-v2 — Strategy compose proof</title>',
    ...HOMER_CSS.map((href) => `<link rel="stylesheet" href="${href}">`),
    '</head>',
    '<body class="bg-body-tertiary">',
    // PRD §A.7 container frame — the only hand-written structural HTML.
    '<div class="container my-4" style="max-width:720px">',
    '<div class="d-flex flex-column gap-3">',
    innerHtml,
    '</div>',
    '</div>',
    ...HOMER_JS.map((src) => `<script src="${src}"></script>`),
    '</body>',
    '</html>',
  ].join('\n');
}
