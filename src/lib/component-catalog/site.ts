// Site-archetype components — public client-site chrome.
//
// Manual TextOS additions, not Homer recon. These four are the pieces a public
// trades site needs that the Homer catalog genuinely does not carry: Homer is a
// dashboard kit, so it has no marketing-site nav, no marketing footer, no
// mobile call/book bar, and no static (non-input) star display.
//
// Added here rather than hand-written inline per src/lib/CLAUDE.md: "If a
// component the platform needs is genuinely missing from the catalog, STOP and
// surface the gap to Rob. Do not invent a replacement." These were surfaced and
// authorized in the Phase 1B brief.
//
// All four are `archetype_fits: ['site']` only — none belongs in a generated
// mini-app. js_init is 'noop' for three of the four: a public marketing page
// should not depend on Homer's JS bundle. site-nav carries a tiny inline
// toggle instead (js_init_snippet), so the mobile drawer works with no vendor
// script.
//
// CSS lives at the WEB origin (textos-web/public/sites/trades-v1.css), never in
// a scoped Astro <style> — agent-rendered markup cannot carry Astro's
// data-astro-cid attribute, so scoped rules would never match it. That is the
// exact bug that broke the Facts page repeaters.

import type { ComponentCatalogEntry } from './types';

export const c_site_nav: ComponentCatalogEntry = {
  id: 'site-nav',
  name: 'Public site navigation bar',
  category: 'navigation',
  description:
    'Sticky top nav for a public client site: logo + wordmark, desktop links, phone CTA, and a mobile drawer. Marketing-site chrome — not the Homer dashboard topbar.',
  homer_classes: 'site-nav site-nav__inner site-nav__links site-nav__cta',
  source_verification: 'custom',
  html_template: `<nav class="site-nav" id="site-nav">
  <div class="site-nav__inner">
    <a class="site-nav__brand" href="{{home_href}}">
      {{#logo_url}}<img class="site-nav__logo" src="{{logo_url}}" alt="{{logo_alt}}" width="40" height="40" />{{/logo_url}}
      <span class="site-nav__brand-text">
        <span class="site-nav__name">{{business_name}}</span>
        {{#tagline}}<span class="site-nav__tagline">{{tagline}}</span>{{/tagline}}
      </span>
    </a>
    <ul class="site-nav__links">
      {{#links}}<li class="site-nav__item {{is_group?nav-dd}}">{{^is_group}}<a class="{{active?is-active}}" href="{{href}}"{{#active}} aria-current="page"{{/active}}>{{label}}</a>{{/is_group}}{{#is_group}}{{#href}}<a class="nav-dd__link {{active?is-active}}" href="{{href}}">{{label}}</a><button type="button" class="nav-dd__toggle nav-dd__toggle--split" aria-expanded="false" aria-haspopup="true" aria-label="Show areas"><span class="nav-dd__arrow" aria-hidden="true">▾</span></button>{{/href}}{{^href}}<button type="button" class="nav-dd__toggle {{active?is-active}}" aria-expanded="false" aria-haspopup="true">{{label}} <span class="nav-dd__arrow" aria-hidden="true">▾</span></button>{{/href}}<ul class="nav-dd__menu" role="menu">{{#children}}<li role="none"><a role="menuitem" class="{{active?is-active}}" href="{{href}}"{{#active}} aria-current="page"{{/active}}>{{label}}</a></li>{{/children}}</ul>{{/is_group}}</li>{{/links}}
    </ul>
    <div class="site-nav__actions">
      {{#phone_display}}<a class="site-nav__phone" href="tel:{{phone_href}}">{{phone_display}}</a>{{/phone_display}}
      {{#cta_label}}<a class="btn-site btn-site--primary" href="{{cta_href}}">{{cta_label}}</a>{{/cta_label}}
    </div>
    <button class="site-nav__burger" type="button" aria-label="Menu" aria-expanded="false" data-site-nav-toggle>
      <span></span><span></span><span></span>
    </button>
  </div>
  <div class="site-nav__drawer" hidden data-site-nav-drawer>
    <ul>{{#links}}<li>{{^is_group}}<a class="{{active?is-active}}" href="{{href}}"{{#active}} aria-current="page"{{/active}}>{{label}}</a>{{/is_group}}{{#is_group}}<div class="nav__drawer-group"><span class="nav__drawer-group-title">{{label}}</span>{{#children}}<a class="{{active?is-active}}" href="{{href}}"{{#active}} aria-current="page"{{/active}}>{{label}}</a>{{/children}}</div>{{/is_group}}</li>{{/links}}</ul>
    {{#phone_display}}<a class="site-nav__drawer-phone" href="tel:{{phone_href}}">{{phone_display}}</a>{{/phone_display}}
  </div>
</nav>`,
  fillable_slots: ['business_name', 'tagline', 'logo_url', 'logo_alt', 'links', 'phone_display', 'phone_href', 'cta_label', 'cta_href'],
  js_init: 'manual',
  js_dependencies: [],
  js_init_snippet:
    "document.querySelector('[data-site-nav-toggle]')?.addEventListener('click',function(){var d=document.querySelector('[data-site-nav-drawer]');var o=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!o));d.hidden=o;});",
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  reliability_notes: 'Custom TextOS component. No vendor JS — the drawer toggle is a 3-line inline listener.',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use:
      'The top navigation of a public client site. Use once per page, first element in the body.',
  },
};

export const c_site_footer: ComponentCatalogEntry = {
  id: 'site-footer',
  name: 'Public site footer',
  category: 'layout',
  description:
    'Client-site footer: brand block, quick links, structured hours table, contact details, license line, and legal row.',
  homer_classes: 'site-footer site-footer__grid site-footer__col',
  source_verification: 'custom',
  html_template: `<footer id="{{anchor}}" class="site-footer">
  <div class="site-footer__grid">
    <div class="site-footer__col site-footer__col--brand">
      {{#logo_url}}<img class="site-footer__logo" src="{{logo_url}}" alt="{{logo_alt}}" width="44" height="44" />{{/logo_url}}
      <div class="site-footer__name">{{business_name}}</div>
      {{#tagline}}<p class="site-footer__tagline">{{tagline}}</p>{{/tagline}}
      {{#phone_display}}<a class="site-footer__link" href="tel:{{phone_href}}">{{phone_display}}</a>{{/phone_display}}
      {{#email}}<a class="site-footer__link" href="mailto:{{email}}">{{email}}</a>{{/email}}
      {{#license_line}}<div class="site-footer__license">{{license_line}}</div>{{/license_line}}
      {{#has_social}}<div class="site-footer__social">
        {{#social}}<a href="{{href}}" rel="noopener" aria-label="{{label}}" title="{{label}}">{{glyph}}</a>{{/social}}
      </div>{{/has_social}}
    </div>
    {{#has_links}}<div class="site-footer__col">
      <h2 class="site-footer__heading">Quick Links</h2>
      <ul class="site-footer__list">{{#links}}<li><a href="{{href}}">{{label}}</a></li>{{/links}}</ul>
    </div>{{/has_links}}
    {{#has_hours}}<div class="site-footer__col">
      <h2 class="site-footer__heading">Hours</h2>
      <table class="site-footer__hours">
        {{#hours}}<tr><th scope="row">{{day}}</th><td>{{value}}</td></tr>{{/hours}}
      </table>
    </div>{{/has_hours}}
    {{#has_address}}<div class="site-footer__col">
      <h2 class="site-footer__heading">Find Us</h2>
      <address class="site-footer__address">{{#street_address}}{{street_address}}<br />{{/street_address}}{{address_line}}</address>
    </div>{{/has_address}}
  </div>
  <div class="site-footer__legal"><span>{{copyright_line}}</span>{{#has_legal}}<span class="site-footer__legal-links">{{#legal_links}}<a href="{{href}}">{{label}}</a>{{/legal_links}}</span>{{/has_legal}}</div>
</footer>`,
  fillable_slots: [
    'anchor', 'home_href', 'business_name', 'tagline', 'logo_url', 'logo_alt', 'phone_display', 'phone_href', 'email',
    'license_line', 'links', 'has_links', 'hours', 'has_hours', 'social', 'has_social',
    'street_address', 'address_line', 'has_address', 'copyright_line',
      'legal_links', 'has_legal',
  ],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  reliability_notes: 'Custom TextOS component. Static markup, no JS.',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use: 'The footer of a public client site. Use once per page, last element before any fixed bars.',
  },
};

export const c_mobile_sticky_bar: ComponentCatalogEntry = {
  id: 'mobile-sticky-bar',
  name: 'Mobile sticky action bar',
  category: 'navigation',
  description:
    'Fixed bottom bar on small screens with the two highest-intent actions (call, book). Hidden at desktop widths by CSS.',
  homer_classes: 'sticky-bar sticky-bar__item',
  source_verification: 'custom',
  html_template: `<div id="{{anchor}}" class="sticky-bar" role="navigation" aria-label="Quick actions">
  {{#phone_href}}<a class="sticky-bar__item" href="tel:{{phone_href}}">{{call_label|Call Now}}</a>{{/phone_href}}
  {{#book_href}}<a class="sticky-bar__item sticky-bar__item--primary" href="{{book_href}}">{{book_label|Book Online}}</a>{{/book_href}}
</div>`,
  fillable_slots: ['anchor', 'phone_href', 'call_label', 'book_href', 'book_label'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  reliability_notes: 'Custom TextOS component. Visibility is pure CSS media query — no JS.',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use: 'Persistent call/book actions on mobile for a local service business.',
  },
};

// NOTE: distinct from the existing `star-rating` (form.ts), which is an INPUT —
// five btn-check radios plus tx-star-rating.js, used to COLLECT a rating. This
// one DISPLAYS a fixed rating: no inputs, no JS, no form semantics. Two
// different components; the ids must not collide.
export const c_star_rating_static: ComponentCatalogEntry = {
  id: 'star-rating-static',
  name: 'Star rating (display only)',
  category: 'display',
  description:
    'Renders a fixed 1-5 star rating for display. Non-interactive counterpart to the `star-rating` form input.',
  homer_classes: 'star-rating-static ti ti-star-filled ti-star',
  source_verification: 'custom',
  html_template: `<span class="star-rating-static" role="img" aria-label="{{value}} out of 5 stars">
  {{#stars}}<i class="ti {{filled?ti-star-filled}}{{^filled}}ti-star{{/filled}}"></i>{{/stars}}
</span>`,
  fillable_slots: ['value', 'stars'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Telegram: render as literal "★★★★☆".',
  reliability_tier: 'core',
  reliability_notes:
    'Custom TextOS component. Display-only sibling of `star-rating`. Currently unused on rendered sites — the reviews section shows its empty state until a real google_place_id exists (AI-generated review content is prohibited).',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use: 'Showing an existing, real rating next to a review or an aggregate badge. Never for collecting input — use `star-rating` for that.',
  },
};

// The trades hero. Homer's `section-hero` (from landing.html) is a centred text
// block on a light background — a different layout, and no amount of media
// makes it the right one. This is the full-bleed, dark, left-aligned split the
// local-service vertical needs, with trust items folded IN rather than sitting
// in a separate band below.
//
// Degrades correctly with no media: `has_media` false yields a solid
// accent-derived background and the identical layout. The section is never
// "broken pending an upload".
export const c_hero_media: ComponentCatalogEntry = {
  id: 'hero-media',
  name: 'Full-bleed media hero',
  category: 'layout',
  description:
    'Edge-to-edge hero with optional image or video background, dark overlay, left-aligned content, dual CTAs, and inline trust items. Falls back to a solid accent background with no media.',
  homer_classes: 'hero-media hero-media__bg hero-media__inner hero-media__ctas hero-media__trust',
  source_verification: 'custom',
  // NOTE THE SPACE before {{has_media?...}}. `{{key?className}}` compiles to
  // {{#key}}className{{/key}} via rest.trim() — it does NOT insert a separator,
  // so `class="hero-media{{has_media?is-media}}"` renders `hero-mediais-media`
  // and NEITHER class matches. That killed position:relative, so the absolutely
  // positioned __bg/__scrim resolved against the initial containing block and
  // painted over the sections below. Every other catalog entry already puts the
  // space outside the construct; `container{{fluid?-fluid}}` in layout.ts is the
  // one place concatenation is deliberate.
  html_template: `<section id="{{anchor}}" class="hero-media {{has_media?is-media}}{{^has_media}}is-solid{{/has_media}}">
  {{#has_media}}<div class="hero-media__bg">
    {{#is_video}}<video class="hero-media__video" autoplay muted loop playsinline preload="metadata"{{#poster_url}} poster="{{poster_url}}"{{/poster_url}} aria-label="{{media_alt}}"><source src="{{media_url}}" type="{{media_mime}}" /></video>{{/is_video}}
    {{^is_video}}<img class="hero-media__img" src="{{media_url}}" alt="{{media_alt}}"{{#media_width}} width="{{media_width}}"{{/media_width}}{{#media_height}} height="{{media_height}}"{{/media_height}} />{{/is_video}}
  </div>{{/has_media}}
  <div class="hero-media__scrim"></div>
  <div class="hero-media__inner">
    <div class="hero-media__content">
      {{#eyebrow}}<div class="hero-media__eyebrow">{{eyebrow}}</div>{{/eyebrow}}
      <h1 class="hero-media__headline">{{headline}}</h1>
      {{#subhead}}<p class="hero-media__subhead">{{subhead}}</p>{{/subhead}}
      {{#has_ctas}}<div class="hero-media__ctas">
        {{#cta_primary_label}}<a class="btn-site btn-site--primary btn-site--lg" href="{{cta_primary_href}}">{{cta_primary_label}}</a>{{/cta_primary_label}}
        {{#cta_secondary_label}}<a class="btn-site btn-site--outline btn-site--lg" href="{{cta_secondary_href}}">{{cta_secondary_label}}</a>{{/cta_secondary_label}}
      </div>{{/has_ctas}}
      {{#has_trust}}<ul class="hero-media__trust">
        {{#trust_items}}<li>{{label}}</li>{{/trust_items}}
      </ul>{{/has_trust}}
    </div>
  </div>
</section>`,
  fillable_slots: [
    'anchor', 'has_media', 'is_video', 'media_url', 'media_mime', 'media_alt', 'media_width', 'media_height', 'poster_url',
    'eyebrow', 'headline', 'subhead',
    'has_ctas', 'cta_primary_label', 'cta_primary_href', 'cta_secondary_label', 'cta_secondary_href',
    'has_trust', 'trust_items',
  ],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  text_mode_notes: 'Telegram: headline + subhead as text, CTAs as inline-keyboard buttons, trust items as a bullet line.',
  reliability_tier: 'core',
  reliability_notes:
    'Custom TextOS component. No vendor JS; video uses native autoplay/muted/loop/playsinline and always carries a poster frame.',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use:
      'The primary hero of a local-service site — full-bleed, media-backed, left-aligned, dual CTA. Use instead of section-hero, which is a centred light block for generated mini-apps.',
  },
};


// The inner-page hero. Seven of the eight page types use it, so it is the
// highest-leverage component in phase 2A.
//
// Smaller than hero-media by design: no CTAs, no trust items, shorter. The
// mockup's own rule is the source for the height —
//   .page-hero { padding-top: calc(70px + var(--space-xl));
//                padding-bottom: var(--space-xl);
//                background: var(--color-surface);
//                border-bottom: 1px solid var(--color-border); }
// The 70px is the sticky nav's height, so content clears it. Same token set as
// hero-media: accent for the label, ink_on_dark for text, scrim over media.
export const c_page_hero: ComponentCatalogEntry = {
  id: 'page-hero',
  name: 'Inner page hero',
  category: 'layout',
  description:
    'Compact hero for an inner page: small accent label, H1, optional subhead, optional background media with scrim. No CTAs — those live further down the page.',
  homer_classes: 'page-hero page-hero__inner page-hero__label',
  source_verification: 'custom',
  // THREE BACKGROUNDS, ONE HERO: a photo, a map, or the solid surface. They are
  // mutually exclusive — the caller sets has_media OR has_map, never both — and
  // the text treatment is identical in all three, which is the whole point of
  // making the map a variant rather than a second hero component.
  //
  // The map is DECORATION: pointer-events are killed in CSS (a pannable map
  // behind a headline fights the content, and a scroll near the hero would zoom
  // the map instead of the page), the wrapper is aria-hidden and the frame is
  // tabindex="-1" so it is not a keyboard trap or a screen-reader detour.
  //
  // Because that kills the embed's OWN attribution link, the caller must supply
  // a live one — see map_attrib_*. It renders above the scrim, at full opacity,
  // outside the aria-hidden wrapper. OSM's terms require visible attribution and
  // "inside a frame nobody can click" does not satisfy that.
  //
  // NOTE THE SPACES around the {{flag?class}} constructs: `{{key?cls}}` compiles
  // to {{#key}}cls{{/key}} with no separator, so writing them adjacent would
  // concatenate two class names into one that matches nothing. Same trap
  // documented on hero-media.
  html_template: `<section id="{{anchor}}" class="page-hero {{has_media?is-media}} {{has_map?is-map}}">
  {{#has_media}}<div class="page-hero__bg">
    <img class="page-hero__img" src="{{media_url}}" alt="{{media_alt}}" />
  </div>
  <div class="page-hero__scrim"></div>{{/has_media}}
  {{#has_map}}<div class="page-hero__bg page-hero__bg--map" aria-hidden="true">
    <iframe class="page-hero__map" src="{{map_src}}" title="{{map_title}}"
            tabindex="-1" loading="lazy" referrerpolicy="no-referrer" style="border:0"></iframe>
  </div>
  <div class="page-hero__scrim"></div>{{/has_map}}
  <div class="page-hero__inner">
    {{#label}}<span class="page-hero__label">{{label}}</span>{{/label}}
    <h1 class="page-hero__headline">{{headline}}</h1>
    {{#subhead}}<p class="page-hero__subhead">{{subhead}}</p>{{/subhead}}
    {{#meta_line}}<p class="page-hero__meta">{{meta_line}}</p>{{/meta_line}}
  </div>
  {{#has_map}}<div class="page-hero__mapfoot">
    {{#map_link_href}}<a class="page-hero__maplink" href="{{map_link_href}}" target="_blank" rel="noopener noreferrer">{{map_link_label|View a larger map}}</a>{{/map_link_href}}
    <a class="page-hero__mapattrib" href="{{map_attrib_href}}" target="_blank" rel="noopener noreferrer">{{map_attrib_label|© OpenStreetMap contributors}}</a>
  </div>{{/has_map}}
</section>`,
  fillable_slots: [
    'anchor', 'label', 'headline', 'subhead', 'meta_line',
    'has_media', 'media_url', 'media_alt',
    'has_map', 'map_src', 'map_title', 'map_link_href', 'map_link_label',
    'map_attrib_href', 'map_attrib_label',
  ],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  reliability_notes: 'Custom TextOS component. Static markup, no JS.',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use:
      'The top of any inner page. Use hero-media instead on a home page, where the hero carries CTAs and trust items.',
  },
};

/**
 * A location map, from OpenStreetMap's official embed endpoint.
 *
 * WHY NOT GOOGLE. The Maps Embed API needs a key in the iframe src — that is,
 * in the public HTML of every client site. The only Google key in this stack is
 * GOOGLE_PLACES_API_KEY, a WRANGLER SECRET used server-side by daycycle-connect;
 * publishing it would leak it and hand anyone the ability to bill Places calls.
 * A separate referrer-restricted Embed key is Rob's to create, and until it
 * exists there is no supported Google path. (The keyless
 * maps.google.com?output=embed form works but is undocumented — if Google
 * changes it, every client site breaks at once, silently.)
 *
 * OSM's export/embed.html is officially embeddable, needs no key, bills nothing
 * and sets no advertising cookies — a real advantage on a page whose visitors
 * are homeowners looking for a phone number. Swapping to Google later is a
 * change to THIS TEMPLATE only, because nothing else composes a map.
 *
 * bbox, not a centre+zoom: the OSM embed takes a bounding box. The caller
 * computes it from the area's lat/lng.
 *
 * loading="lazy" plus explicit dimensions: an iframe directly under the hero is
 * inside the first viewport on desktop, so lazy loading alone does not save the
 * request there — the fixed height is what stops it shifting the page while it
 * arrives.
 */
export const c_map_embed_osm: ComponentCatalogEntry = {
  id: 'map-embed-osm',
  name: 'Location map (OpenStreetMap)',
  category: 'display',
  description:
    'Keyless embedded map centred on a bounding box, with an optional marker. For showing where a service area is on a public client site.',
  homer_classes: 'area-map area-map__frame',
  source_verification: 'custom',
  html_template: `<div class="area-map" id="{{anchor}}">
  <iframe class="area-map__frame"
          src="https://www.openstreetmap.org/export/embed.html?bbox={{bbox}}&amp;layer=mapnik{{#marker}}&amp;marker={{marker}}{{/marker}}"
          title="{{title}}"
          width="100%" height="{{height|360}}"
          loading="lazy" referrerpolicy="no-referrer"
          style="border:0"></iframe>
  {{#link_href}}<a class="area-map__link" href="{{link_href}}" target="_blank" rel="noopener noreferrer">{{link_label|View a larger map}}</a>{{/link_href}}
</div>`,
  fillable_slots: ['anchor', 'bbox', 'marker', 'title', 'height', 'link_href', 'link_label'],
  js_init: 'noop',
  js_dependencies: [],
  mobile_responsive: true,
  text_mode: 'adapted',
  reliability_tier: 'core',
  reliability_notes:
    'Custom TextOS component. No JS and no API key. Third-party iframe: it will not render where the network blocks openstreetmap.org, which is why the caller only composes it when the area has real coordinates.',
  archetype_fits: ['site'],
  capabilities: {
    when_to_use:
      'A public page about one place, where showing where that place is helps a visitor. Not for a mini-app.',
  },
};

export const SITE_COMPONENTS: ComponentCatalogEntry[] = [
  c_site_nav,
  c_site_footer,
  c_mobile_sticky_bar,
  c_star_rating_static,
  c_hero_media,
  c_page_hero,
  c_map_embed_osm,
];
