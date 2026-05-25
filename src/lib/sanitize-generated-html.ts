/**
 * sanitizeGeneratedHtml — regex pass over LLM-produced HTML/JS to
 * neutralize patterns that violate the TXAPP execution contract.
 *
 * This is intentionally NOT a full AST parser. Regex is fast, runs in
 * the Worker invocation, and catches the common direct-syntax patterns
 * a prompt-injected LLM would emit. Evasion via string concatenation,
 * eval, dynamic property access, etc. is NOT caught — those are V1.1
 * concerns and require either an AST sandbox or a properly isolated
 * subdomain origin (the right long-term fix).
 *
 * What we neutralize (with /* TX_SANITIZED... *​/ comment markers so the
 * admin queue can spot them):
 *   - fetch("http(s)://...") calls with literal external URLs
 *   - new XMLHttpRequest()
 *   - localStorage.(get|set|remove)Item("...") where the key does NOT
 *     start with tx_vt_  (TXAPP's own visitor-token key is preserved)
 *   - localStorage.clear()
 *   - document.cookie
 *   - window.parent
 *
 * Return shape: { html, removals[] }. Caller logs `removals` to
 * app_bug_log so the admin queue sees what was stripped.
 */

export interface SanitizationRemoval {
  /** Stable pattern name (matches RULES[].name). */
  pattern: string;
  /** Number of matches replaced. */
  count: number;
  /** Up to 3 samples of the original matched text, truncated to 120 chars. */
  samples: string[];
}

export interface SanitizationResult {
  html: string;
  removals: SanitizationRemoval[];
}

interface PatternRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

// IMPORTANT: the regexes below are intentionally narrow. We accept false
// negatives (evasions via aliasing or string concat) over false positives
// that would corrupt legitimate app code. The admin queue catches what we
// miss — V1.1 isolation (subdomain origin) is the real fix.
const RULES: PatternRule[] = [
  {
    // fetch("https://...") or fetch('http://...') — literal external URL.
    name: "fetch_external_url",
    pattern: /fetch\s*\(\s*(["'])(https?:\/\/[^"']*?)\1/gi,
    replacement: 'fetch(/* TX_SANITIZED_EXTERNAL_URL */ ""',
  },
  {
    name: "xmlhttprequest",
    pattern: /\bnew\s+XMLHttpRequest\s*\(\s*\)/gi,
    replacement:
      "/* TX_SANITIZED_XHR */ ({ open(){}, send(){}, setRequestHeader(){}, abort(){} })",
  },
  {
    // localStorage.{get,set,remove}Item("key") where key does NOT start with tx_vt_.
    // The TXAPP global's own localStorage usage (tx_vt_{{BUSINESS_ID}}) is preserved.
    name: "localstorage_non_txapp",
    pattern:
      /localStorage\.(getItem|setItem|removeItem)\s*\(\s*["'](?!tx_vt_)([^"']*)["']/gi,
    replacement: 'null /* TX_SANITIZED_LOCALSTORAGE_NON_TXAPP */ /*',
  },
  {
    name: "localstorage_clear",
    pattern: /localStorage\.clear\s*\(\s*\)/gi,
    replacement: "void 0 /* TX_SANITIZED_LOCALSTORAGE_CLEAR */",
  },
  {
    name: "document_cookie",
    pattern: /\bdocument\.cookie\b/gi,
    replacement: '"" /* TX_SANITIZED_COOKIE */',
  },
  {
    name: "window_parent",
    pattern: /\bwindow\.parent\b/gi,
    replacement: "null /* TX_SANITIZED_PARENT */",
  },
];

export function sanitizeGeneratedHtml(html: string): SanitizationResult {
  let out = html;
  const removals: SanitizationRemoval[] = [];

  for (const rule of RULES) {
    const samples: string[] = [];
    let count = 0;
    out = out.replace(rule.pattern, (match) => {
      count++;
      if (samples.length < 3) samples.push(match.slice(0, 120));
      return rule.replacement;
    });
    if (count > 0) removals.push({ pattern: rule.name, count, samples });
  }

  return { html: out, removals };
}
