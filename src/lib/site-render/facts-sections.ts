// The Business Facts page's own section registry — SINGLE SOURCE OF TRUTH.
//
// WHY THIS FILE EXISTS
//
// The site manager showed derived fields as "from Business Facts → google place
// id". That names a FIELD, while the Facts page is organised by SECTION HEADING
// ("Where your proof lives"). Two vocabularies with nothing connecting them: a
// client followed the link and had to guess which block they had landed in.
//
// The fix needs the heading text in two places — rendered as the Facts page
// heading, and quoted in the manager's link. Duplicating the string guarantees
// they drift, so it lives here and BOTH read from it:
//
//   * GET /api/businesses/:slug/facts returns `sections`, and facts.astro
//     renders each band heading from it. The markup carries only a stable KEY
//     (data-facts-section="proof"), never the visible words.
//   * business-site.ts maps a derived field's source_path to the owning section
//     and quotes `heading` verbatim, so a client searching the Facts page for
//     the words in the link finds the block.
//
// Adding a band to the Facts page means adding an entry here. If a band's key is
// missing from the markup the heading simply does not render, which is visible
// immediately — the failure mode is loud, not a silently stale string.

/** Anchor id for a Facts section. Derived, so a link can never point at a
 *  hand-typed id that no longer exists. */
export function factsAnchor(key: string): string {
  return `facts-${key}`;
}

export interface FactsSection {
  /** Stable key. Appears in the markup as data-facts-section and in the anchor. */
  key: string;
  /** Small label above the heading. */
  eyebrow: string;
  /** The heading AS THE CLIENT READS IT. Quoted verbatim by the manager. */
  heading: string;
  /** Which profile columns / collections this band owns. Used to resolve a
   *  source_path back to the band that contains it. */
  owns: string[];
}

export const FACTS_SECTIONS: FactsSection[] = [
  {
    key: 'identity', eyebrow: 'Identity', heading: 'What the business is called',
    owns: ['legal_name', 'alternate_name', 'description', 'logo_media_id', 'hero_media_id'],
  },
  {
    key: 'contact', eyebrow: 'Contact', heading: 'How customers reach you',
    owns: ['phone', 'email', 'street_address', 'locality', 'region', 'postal_code', 'country', 'geo_lat', 'geo_lng'],
  },
  {
    key: 'hours', eyebrow: 'Hours', heading: "When you're open",
    owns: ['hours'],
  },
  {
    key: 'credentials', eyebrow: 'Credentials', heading: 'License',
    owns: ['license_number', 'license_authority'],
  },
  {
    key: 'services', eyebrow: 'Services', heading: 'What you do',
    owns: ['services'],
  },
  {
    key: 'areas', eyebrow: 'Service areas', heading: 'Where you work',
    owns: ['areas'],
  },
  {
    key: 'faqs', eyebrow: 'FAQs', heading: 'Questions you get asked',
    owns: ['faqs'],
  },
  {
    key: 'projects', eyebrow: 'Projects', heading: "Work you've completed",
    owns: ['projects'],
  },
  {
    key: 'differentiators', eyebrow: 'Differentiators', heading: 'Why customers pick you',
    owns: ['differentiators'],
  },
  {
    key: 'proof', eyebrow: 'Reviews & social', heading: 'Where your proof lives',
    owns: ['google_place_id', 'google_business_url', 'facebook_url', 'instagram_url', 'analytics_id'],
  },
];

/** Human name for a single field, for the "…→ heading (field)" suffix. */
const FIELD_NAMES: Record<string, string> = {
  legal_name: 'legal name', alternate_name: 'alternate name', description: 'description',
  phone: 'phone number', email: 'email address', street_address: 'street address',
  locality: 'city', region: 'state', postal_code: 'postal code', country: 'country',
  geo_lat: 'latitude', geo_lng: 'longitude', hours: 'opening hours',
  license_number: 'license number', license_authority: 'issuing authority',
  google_place_id: 'Google Place ID', google_business_url: 'Google Business URL',
  facebook_url: 'Facebook URL', instagram_url: 'Instagram URL', analytics_id: 'analytics ID',
  logo_media_id: 'logo', hero_media_id: 'main photo',
  services: 'services', areas: 'service areas', faqs: 'FAQs',
  projects: 'projects', differentiators: 'differentiators',
};

export interface ResolvedSource {
  /** "Business Facts → Where your proof lives" */
  label: string;
  /** The specific field, for the parenthetical. May be null for a whole collection. */
  field_name: string | null;
  /** Which page to open: the Facts page or the Context Data page. */
  where: 'facts' | 'context';
  /** Anchor on that page, e.g. "facts-proof". Null when unknown. */
  anchor: string | null;
  /** Field to highlight on arrival, so a long form is navigable. */
  highlight: string | null;
}

/**
 * "4 services" / "1 service" — the counted noun for a collection.
 *
 * The manager prints this as part of a sentence, so a plural noun with a count of
 * one reads as a bug: "1 service areas" was on screen before this existed.
 *
 * De-pluralisation is naive ON PURPOSE. Every collection noun in FIELD_NAMES ends
 * in a plain "s" — services, service areas, FAQs, projects, differentiators — so
 * dropping it is correct for all of them, and deriving the singular beats keeping a
 * second set of words in sync with the first. A future irregular noun needs an
 * entry in IRREGULAR; this is the one place to add it.
 *
 * It lives here so the manager's UI writes no words of its own at all.
 */
const IRREGULAR: Record<string, string> = {};

export function countedNoun(count: number, noun: string): string {
  if (count !== 1) return `${count} ${noun}`;
  return `1 ${IRREGULAR[noun] ?? (noun.endsWith('s') ? noun.slice(0, -1) : noun)}`;
}

/**
 * Which fact collection each site SECTION draws on.
 *
 * Lives here rather than in the route because it is the same vocabulary as
 * FACTS_SECTIONS — the join between "a section on the page" and "a band on the
 * Facts page" — and because a wrong entry sends an operator to the wrong band,
 * which is worth a test. A section absent from this map has no fact source: every
 * word it shows is authored in the manager.
 *
 * Two sections may share a collection (faq_teaser and faq_accordion; services_grid
 * and service_detail) — the same content, framed twice.
 */
export const SECTION_FACT_COLLECTION: Record<string, string> = {
  services_grid: 'services',
  service_detail: 'services',
  featured_work: 'projects',
  faq_teaser: 'faqs',
  faq_accordion: 'faqs',
  differentiator_band: 'differentiators',
  differentiator_list: 'differentiators',
  service_area_chips: 'areas',
  // The area index. Same collection as the chips, so the manager shows its fact
  // contents — and the duplicate-content score, which hangs off the collection —
  // on the page the area pages actually belong to.
  area_card_grid: 'areas',
  reviews: 'google_place_id',
};

/**
 * The Facts band that owns a COLLECTION, by collection name.
 *
 * resolveSource answers the same question for a derived field's source_path. This
 * one is for callers that already hold a collection ("services", "faqs") rather
 * than a path — the site manager naming the fact source of a whole section, not of
 * one field. Same FACTS_SECTIONS lookup, same FIELD_NAMES nouns: no caller anywhere
 * writes its own words for a band or a collection.
 */
export function resolveCollection(collection: string): ResolvedSource {
  const section = FACTS_SECTIONS.find((s) => s.owns.includes(collection));
  if (!section) {
    return { label: 'Business Facts', field_name: null, where: 'facts', anchor: null, highlight: null };
  }
  return {
    label: `Business Facts → ${section.heading}`,
    field_name: FIELD_NAMES[collection] ?? collection.replace(/_/g, ' '),
    where: 'facts',
    anchor: factsAnchor(section.key),
    highlight: null,
  };
}

/**
 * Map a derived field's source_path to the Facts band that contains it.
 *
 * Grammar (migration 092): profile.<col> | profile.hours |
 * services[<key>].<f> | areas[<slug>].<f> | context.<key>
 */
export function resolveSource(path: string): ResolvedSource {
  const p = path.trim();

  // business_context lives on a different page entirely.
  if (p.startsWith('context.')) {
    const key = p.slice('context.'.length);
    return {
      label: 'Context Data',
      field_name: key.replace(/_/g, ' '),
      where: 'context', anchor: null, highlight: null,
    };
  }

  let field: string | null = null;
  if (p === 'profile.hours') field = 'hours';
  else if (p.startsWith('profile.')) field = p.slice('profile.'.length);
  else if (p.startsWith('services')) field = 'services';
  else if (p.startsWith('areas')) field = 'areas';

  const section = field
    ? FACTS_SECTIONS.find((s) => s.owns.includes(field as string))
    : undefined;

  if (!section) {
    // Unknown path — say so plainly rather than inventing a destination.
    return { label: 'Business Facts', field_name: null, where: 'facts', anchor: null, highlight: null };
  }

  const isCollection = ['services', 'areas', 'faqs', 'projects', 'differentiators', 'hours'].includes(field as string);
  return {
    label: `Business Facts → ${section.heading}`,
    field_name: FIELD_NAMES[field as string] ?? (field as string).replace(/_/g, ' '),
    where: 'facts',
    anchor: factsAnchor(section.key),
    // A collection has no single input to highlight; a scalar column does.
    highlight: isCollection ? null : (field as string),
  };
}
