-- =====================================================================
-- Migration 092: Seed site_templates row — trades-v1
-- =====================================================================
-- Source: WEBSITE MANAGER — PHASE 1A (REVISED), STEP 2 (brief, 2026-07-27).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: migration 091 (creates public.site_templates).
-- Safe to re-run: single INSERT ... ON CONFLICT (template_key) DO UPDATE.
-- =====================================================================
--
-- WHAT THIS IS
--
-- One row. `section_catalog` is the structural inventory of the trades
-- template, captured verbatim from the 2026-07-27 recon of
-- https://trustlight.ai/jk-quality-electric/mockup/ (19 pages fetched, all 200).
-- It is NOT re-derived here — it is the recon artifact, embedded as-is:
--   9 page types (2 repeatable: legal x2, area_detail x10)
--   4 shared regions (site_nav, cta_band, site_footer, chat_widget)
--   29 site-level fields
--   7 repeatable collections
--   12 placeholder tokens, all mapped to fields
--   structured-data plan + 3 recorded defects in the source
--
-- `field_derivation_map` is the Step 2 addition: for every field, either the
-- source_path of the business fact it derives from, or an explicit
-- site_authored marker. This is what Phase 1B reads to decide what to copy
-- from business facts and what to ask a human for.
--
-- status = 'draft'. Nothing renders from this row in Phase 1A. Flip to
-- 'active' when Phase 1B can actually compose it.
--
-- NOTE ON REVIEWS: the reviews collection is marked policy=NEVER_GENERATED and
-- derives only from profile.google_place_id. textos-agent/CLAUDE.md prohibits
-- AI-generated testimonials on FTC grounds. The section renders empty until a
-- real place_id exists. There is no column anywhere in this schema for review
-- text, by design.
-- =====================================================================

INSERT INTO public.site_templates
  (template_key, name, vertical, version, status, section_catalog, field_derivation_map)
VALUES (
  'trades-v1',
  'Local Trades — v1',
  'local_service_trade',
  '1',
  'draft',
  $json${
  "catalog_version": "0.1.0-draft",
  "source": "https://trustlight.ai/jk-quality-electric/mockup/",
  "captured_at": "2026-07-27",
  "vertical": "local_service_trade",
  "notes": "Draft seed for a website_templates.section_catalog column. Field keys are proposals, not shipped. 'fill' names the context source we could actually read today; NOT_PRESENT means nothing in businesses/business_context holds it (see recon Part 4).",
  "global": {
    "site_fields": [
      {
        "field_key": "business_name",
        "type": "text",
        "example": "JK Quality Electric",
        "fill": "businesses.name"
      },
      {
        "field_key": "business_alt_name",
        "type": "text",
        "example": "J. K. Quality Electric",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "tagline",
        "type": "text",
        "example": "Licensed Electricians",
        "fill": "businesses.hero_eyebrow (approx)"
      },
      {
        "field_key": "logo_image",
        "type": "image",
        "example": "images/logo.jpg",
        "fill": "business_assets asset_type='logo'"
      },
      {
        "field_key": "phone_e164",
        "type": "text",
        "example": "+15044420980",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "phone_display",
        "type": "text",
        "example": "(504) 442-0980",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "email",
        "type": "text",
        "example": "info@jkqualityelectric.com",
        "fill": "users.email (owner, not business)"
      },
      {
        "field_key": "address_locality",
        "type": "text",
        "example": "Chalmette",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "address_region",
        "type": "text",
        "example": "LA",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "address_postal",
        "type": "text",
        "example": "70043",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "address_country",
        "type": "text",
        "example": "US",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "geo_lat",
        "type": "number",
        "example": 29.9413,
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "geo_lng",
        "type": "number",
        "example": -89.9682,
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "license_number",
        "type": "text",
        "example": "75122",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "license_authority",
        "type": "text",
        "example": "Louisiana Electrical Contractor",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "price_range",
        "type": "text",
        "example": "$$",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "hours",
        "type": "list",
        "item_fields": [
          "day_range",
          "opens",
          "closes",
          "closed_flag"
        ],
        "example": [
          {
            "day_range": "Mon – Sat",
            "opens": "07:00",
            "closes": "19:00"
          },
          {
            "day_range": "Sunday",
            "closed_flag": true
          }
        ],
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "years_in_business",
        "type": "text",
        "example": "10+",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "home_base_area",
        "type": "text",
        "example": "Saint Bernard Parish",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "theme_color",
        "type": "text",
        "example": "#F0921E",
        "fill": "businesses.accent_color / accent_color_override"
      },
      {
        "field_key": "canonical_origin",
        "type": "link",
        "example": "https://jkqualityelectric.com",
        "fill": "businesses.existing_business_url (sometimes)"
      },
      {
        "field_key": "social_facebook",
        "type": "link",
        "placeholder_token": "[FACEBOOK_URL]",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "social_instagram",
        "type": "link",
        "placeholder_token": "[INSTAGRAM_URL]",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "google_business_url",
        "type": "link",
        "placeholder_token": "[GOOGLE_BUSINESS_URL]",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "google_review_url",
        "type": "link",
        "placeholder_token": "[GOOGLE_REVIEW_URL]",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "analytics_id",
        "type": "text",
        "placeholder_token": "[ANALYTICS_ID]",
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "booking_url",
        "type": "link",
        "example": "Housecall Pro booking",
        "fill": "businesses.calendly_url (partial)"
      },
      {
        "field_key": "review_rating_avg",
        "type": "number",
        "example": null,
        "fill": "NOT_PRESENT"
      },
      {
        "field_key": "review_count",
        "type": "number",
        "example": null,
        "fill": "NOT_PRESENT"
      }
    ],
    "collections": {
      "services": {
        "repeatable": true,
        "observed_count": 4,
        "anchor_ids": [
          "repair",
          "installation",
          "inspection",
          "maintenance"
        ],
        "item_fields": [
          {
            "field_key": "service_key",
            "type": "text"
          },
          {
            "field_key": "service_name",
            "type": "text",
            "example": "Repair"
          },
          {
            "field_key": "service_icon",
            "type": "text",
            "example": "emoji or glyph"
          },
          {
            "field_key": "service_blurb",
            "type": "text",
            "example": "Fast, code-compliant fixes when something's wrong."
          },
          {
            "field_key": "service_body",
            "type": "text",
            "note": "long form, services.html only"
          },
          {
            "field_key": "service_bullets",
            "type": "list",
            "note": "5-6 per service on services.html"
          },
          {
            "field_key": "service_anchor",
            "type": "link"
          }
        ],
        "fill": "NOT_PRESENT (no services table; nearest is business_context.business_model free text)"
      },
      "service_areas": {
        "repeatable": true,
        "observed_count": 10,
        "item_fields": [
          {
            "field_key": "area_slug",
            "type": "text",
            "example": "kenner-la-electrician"
          },
          {
            "field_key": "area_city",
            "type": "text",
            "example": "Kenner"
          },
          {
            "field_key": "area_region",
            "type": "text",
            "example": "LA"
          },
          {
            "field_key": "area_postal",
            "type": "text",
            "example": "70062"
          },
          {
            "field_key": "area_admin_area",
            "type": "text",
            "example": "Jefferson Parish, Louisiana"
          },
          {
            "field_key": "area_geo_lat",
            "type": "number",
            "example": 29.9941
          },
          {
            "field_key": "area_geo_lng",
            "type": "number",
            "example": -90.2417
          },
          {
            "field_key": "area_local_blurb",
            "type": "text",
            "example": "the gateway to the metro near MSY airport.",
            "note": "THE ONLY GENUINELY UNIQUE COPY across the 10 area pages"
          },
          {
            "field_key": "area_landmarks_blurb",
            "type": "text",
            "example": "from Williams Boulevard to the lakefront"
          }
        ],
        "fill": "NOT_PRESENT"
      },
      "faqs": {
        "repeatable": true,
        "observed_count": {
          "faq_page": 9,
          "home_teaser": 4,
          "per_area_page": 3
        },
        "item_fields": [
          {
            "field_key": "faq_question",
            "type": "text"
          },
          {
            "field_key": "faq_answer",
            "type": "text"
          },
          {
            "field_key": "faq_scope",
            "type": "text",
            "enum": [
              "global",
              "area"
            ]
          }
        ],
        "fill": "NOT_PRESENT"
      },
      "projects": {
        "repeatable": true,
        "observed_count": {
          "home_featured": 6,
          "projects_page": 8
        },
        "item_fields": [
          {
            "field_key": "project_image",
            "type": "image",
            "placeholder_token": "[Replace with real photo]"
          },
          {
            "field_key": "project_caption",
            "type": "text",
            "example": "200A panel upgrade — Chalmette, LA"
          },
          {
            "field_key": "project_city",
            "type": "text"
          },
          {
            "field_key": "project_service_key",
            "type": "text"
          }
        ],
        "fill": "NOT_PRESENT"
      },
      "reviews": {
        "repeatable": true,
        "observed_count": 3,
        "observed_real": 1,
        "observed_placeholder": 2,
        "item_fields": [
          {
            "field_key": "review_text",
            "type": "text",
            "placeholder_token": "[REPLACE WITH REAL REVIEW — pull from Google Business or Housecall Pro]"
          },
          {
            "field_key": "review_author",
            "type": "text"
          },
          {
            "field_key": "review_stars",
            "type": "number"
          },
          {
            "field_key": "review_source",
            "type": "text",
            "example": "Google Reviews"
          }
        ],
        "fill": "NOT_PRESENT"
      },
      "differentiators": {
        "repeatable": true,
        "observed_count": {
          "home_pillars": 3,
          "why_us_page": 5,
          "area_pillars": 3
        },
        "item_fields": [
          {
            "field_key": "diff_icon",
            "type": "text"
          },
          {
            "field_key": "diff_headline",
            "type": "text",
            "example": "Licensed, No Exceptions"
          },
          {
            "field_key": "diff_body",
            "type": "text"
          }
        ],
        "fill": "business_context.key_differentiators (list of strings — headline/body not split)"
      },
      "nav_links": {
        "repeatable": true,
        "observed_count": 6,
        "item_fields": [
          {
            "field_key": "nav_label",
            "type": "text"
          },
          {
            "field_key": "nav_href",
            "type": "link"
          },
          {
            "field_key": "nav_children",
            "type": "list",
            "note": "Service Areas dropdown = the 10 area pages"
          }
        ],
        "fill": "businesses.nav_links (exists, different shape: {label, anchor})"
      }
    }
  },
  "page_types": [
    {
      "page_type": "home",
      "repeatable": false,
      "route": "/",
      "jsonld": [
        "LocalBusiness",
        "FAQPage"
      ],
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true,
          "fields": [
            "logo_image",
            "tagline",
            "nav_links",
            "phone_display",
            "nav_cta_label",
            "nav_cta_href"
          ]
        },
        {
          "order": 2,
          "section_key": "hero_home",
          "fields": [
            "hero_eyebrow",
            "hero_headline",
            "hero_subhead",
            "hero_image",
            "hero_image_alt",
            "hero_cta_primary_label",
            "hero_cta_primary_href",
            "hero_cta_secondary_label",
            "hero_cta_secondary_href",
            "hero_trust_items[4]"
          ]
        },
        {
          "order": 3,
          "section_key": "trust_bar",
          "fields": [
            "trust_items[5] (license, tenure, guarantee, hours, booking)"
          ]
        },
        {
          "order": 4,
          "section_key": "services_grid",
          "anchor": "services",
          "fields": [
            "section_eyebrow",
            "section_headline",
            "services[4] -> service_name, service_icon, service_blurb, service_anchor"
          ]
        },
        {
          "order": 5,
          "section_key": "positioning_band",
          "fields": [
            "section_eyebrow",
            "positioning_quote",
            "differentiators[3] -> diff_icon, diff_headline, diff_body"
          ]
        },
        {
          "order": 6,
          "section_key": "featured_work",
          "anchor": "work",
          "fields": [
            "section_eyebrow",
            "section_headline",
            "projects[6] -> project_image, project_caption"
          ]
        },
        {
          "order": 7,
          "section_key": "reviews",
          "anchor": "reviews",
          "fields": [
            "section_eyebrow",
            "section_headline",
            "review_aggregate_badge",
            "google_review_url",
            "reviews[3] -> review_text, review_author, review_stars, review_source"
          ]
        },
        {
          "order": 8,
          "section_key": "service_area_chips",
          "anchor": "service-area",
          "fields": [
            "section_eyebrow",
            "section_headline",
            "service_area_subhead",
            "service_areas[10] -> area_city, area_href"
          ]
        },
        {
          "order": 9,
          "section_key": "differentiator_band",
          "fields": [
            "section_eyebrow",
            "section_headline",
            "band_body",
            "band_tags[3]"
          ]
        },
        {
          "order": 10,
          "section_key": "faq_teaser",
          "anchor": "faq-home",
          "fields": [
            "section_eyebrow",
            "section_headline",
            "faqs[4]"
          ]
        },
        {
          "order": 11,
          "section_key": "cta_band",
          "anchor": "book",
          "shared": true,
          "fields": [
            "cta_headline",
            "cta_primary_label",
            "cta_primary_href",
            "cta_secondary_label",
            "cta_secondary_href"
          ]
        },
        {
          "order": 12,
          "section_key": "site_footer",
          "shared": true,
          "fields": [
            "logo_image",
            "footer_tagline",
            "phone_display",
            "email",
            "license_line",
            "quick_links",
            "hours",
            "social_facebook",
            "social_instagram",
            "google_business_url",
            "copyright_line"
          ]
        },
        {
          "order": 13,
          "section_key": "chat_widget",
          "shared": true,
          "fields": [
            "chat_enabled",
            "chat_greeting",
            "chat_input_placeholder"
          ]
        },
        {
          "order": 14,
          "section_key": "mobile_sticky_bar",
          "shared": true,
          "fields": [
            "sticky_call_label",
            "sticky_book_label",
            "sticky_book_href"
          ]
        }
      ]
    },
    {
      "page_type": "services",
      "repeatable": false,
      "route": "/services.html",
      "jsonld": [
        "Service"
      ],
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "page_hero_headline",
            "page_hero_subhead"
          ]
        },
        {
          "order": 3,
          "section_key": "service_detail",
          "repeatable": true,
          "instances": 4,
          "anchor_from": "service_key",
          "fields": [
            "service_name",
            "service_headline",
            "service_body",
            "service_bullets[5-6]",
            "service_image",
            "service_cta_label",
            "service_cta_href"
          ],
          "note": "installation instance nests a 6-card sub-grid: sub_service_name + sub_service_body"
        },
        {
          "order": 4,
          "section_key": "cta_band",
          "shared": true
        },
        {
          "order": 5,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "projects",
      "repeatable": false,
      "route": "/projects.html",
      "jsonld": [],
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "page_hero_headline",
            "page_hero_subhead"
          ]
        },
        {
          "order": 3,
          "section_key": "project_gallery",
          "fields": [
            "gallery_intro_note",
            "projects[8] -> project_image, project_caption"
          ]
        },
        {
          "order": 4,
          "section_key": "gallery_cta",
          "fields": [
            "cta_line",
            "cta_label",
            "cta_href"
          ]
        },
        {
          "order": 5,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "why_us",
      "repeatable": false,
      "route": "/why-us.html",
      "jsonld": [],
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "page_hero_headline",
            "page_hero_subhead"
          ]
        },
        {
          "order": 3,
          "section_key": "story_prose",
          "fields": [
            "story_headline",
            "story_paragraphs[3]"
          ]
        },
        {
          "order": 4,
          "section_key": "differentiator_list",
          "fields": [
            "section_headline",
            "differentiators[5] -> diff_headline, diff_body"
          ]
        },
        {
          "order": 5,
          "section_key": "license_callout",
          "fields": [
            "license_headline",
            "license_body",
            "license_verify_url"
          ]
        },
        {
          "order": 6,
          "section_key": "service_area_chips",
          "anchor": "service-area",
          "shared": true
        },
        {
          "order": 7,
          "section_key": "cta_band",
          "shared": true
        },
        {
          "order": 8,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "faq",
      "repeatable": false,
      "route": "/faq.html",
      "jsonld": [
        "FAQPage"
      ],
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "page_hero_headline",
            "page_hero_subhead"
          ]
        },
        {
          "order": 3,
          "section_key": "faq_accordion",
          "fields": [
            "faqs[9] -> faq_question, faq_answer"
          ]
        },
        {
          "order": 4,
          "section_key": "faq_footer_cta",
          "fields": [
            "cta_line",
            "cta_label",
            "cta_href"
          ]
        },
        {
          "order": 5,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "contact",
      "repeatable": false,
      "route": "/contact.html",
      "jsonld": [
        "ContactPage"
      ],
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "page_hero_headline",
            "page_hero_subhead"
          ]
        },
        {
          "order": 3,
          "section_key": "contact_form",
          "anchor": "book",
          "fields": [
            "form_headline",
            "form_action_url",
            "form_honeypot",
            "field_name",
            "field_phone",
            "field_email",
            "field_service_select (options = services[])",
            "field_message",
            "submit_label"
          ]
        },
        {
          "order": 4,
          "section_key": "contact_direct",
          "fields": [
            "direct_headline",
            "phone_display",
            "email",
            "hours",
            "service_area_line",
            "booking_url"
          ]
        },
        {
          "order": 5,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "legal",
      "repeatable": true,
      "instances": [
        "tos",
        "privacy"
      ],
      "route": "/{doc_slug}.html",
      "jsonld": [],
      "robots": "Disallow",
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "doc_title",
            "last_updated"
          ],
          "placeholder_token": "[DATE — insert before launch]"
        },
        {
          "order": 3,
          "section_key": "legal_notice",
          "fields": [
            "disclaimer_body"
          ]
        },
        {
          "order": 4,
          "section_key": "legal_body",
          "fields": [
            "clauses[12] -> clause_number, clause_heading, clause_body"
          ],
          "placeholder_token": "[CLIENT: Insert ...]"
        },
        {
          "order": 5,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "area_index",
      "repeatable": false,
      "route": "/areas/",
      "jsonld": [],
      "note": "NOT in the original 18-page brief — discovered via sitemap.xml; page exists and returns 200",
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "page_hero",
          "fields": [
            "page_hero_headline",
            "page_hero_subhead"
          ]
        },
        {
          "order": 3,
          "section_key": "area_card_grid",
          "fields": [
            "service_areas[10] -> area_city, area_href, area_blurb"
          ]
        },
        {
          "order": 4,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    },
    {
      "page_type": "area_detail",
      "repeatable": true,
      "instances": 10,
      "route": "/areas/{area_slug}",
      "jsonld": [
        "LocalBusiness",
        "BreadcrumbList",
        "FAQPage"
      ],
      "duplicate_content_risk": "HIGH — 92.5% mean word-level similarity after masking city/zip/parish names",
      "sections": [
        {
          "order": 1,
          "section_key": "site_nav",
          "shared": true
        },
        {
          "order": 2,
          "section_key": "breadcrumb_nav",
          "fields": [
            "crumbs[3] -> crumb_label, crumb_href"
          ]
        },
        {
          "order": 3,
          "section_key": "area_hero",
          "fields": [
            "area_hero_headline",
            "area_landmarks_blurb",
            "cta_primary_label",
            "phone_display",
            "trust_chips[3]"
          ]
        },
        {
          "order": 4,
          "section_key": "area_services_grid",
          "fields": [
            "section_headline",
            "services[4] -> service_name, service_blurb_localized, service_anchor"
          ]
        },
        {
          "order": 5,
          "section_key": "area_positioning",
          "fields": [
            "section_headline",
            "differentiators[3] -> diff_headline, diff_body_localized",
            "area_local_blurb"
          ]
        },
        {
          "order": 6,
          "section_key": "area_faq",
          "fields": [
            "section_headline",
            "faqs[3] -> faq_question, faq_answer"
          ]
        },
        {
          "order": 7,
          "section_key": "area_map_nearby",
          "fields": [
            "map_embed_or_placeholder",
            "nearby_areas_line"
          ]
        },
        {
          "order": 8,
          "section_key": "cta_band",
          "shared": true
        },
        {
          "order": 9,
          "section_key": "site_footer",
          "shared": true
        }
      ]
    }
  ],
  "placeholder_tokens": [
    {
      "token": "[GOOGLE_REVIEW_URL]",
      "found_in": [
        "home.html"
      ],
      "maps_to": "google_review_url"
    },
    {
      "token": "[GOOGLE_BUSINESS_URL]",
      "found_in": [
        "home.html"
      ],
      "maps_to": "google_business_url"
    },
    {
      "token": "[FACEBOOK_URL]",
      "found_in": [
        "home.html"
      ],
      "maps_to": "social_facebook"
    },
    {
      "token": "[INSTAGRAM_URL]",
      "found_in": [
        "home.html"
      ],
      "maps_to": "social_instagram"
    },
    {
      "token": "[ANALYTICS_ID]",
      "found_in": [
        "home.html"
      ],
      "maps_to": "analytics_id"
    },
    {
      "token": "[Replace with real photo]",
      "found_in": [
        "home.html",
        "projects.html"
      ],
      "count": 14,
      "maps_to": "projects[].project_image"
    },
    {
      "token": "[REPLACE WITH REAL REVIEW — pull from Google Business or Housecall Pro]",
      "found_in": [
        "home.html"
      ],
      "count": 2,
      "maps_to": "reviews[].review_text"
    },
    {
      "token": "[DATE — insert before launch]",
      "found_in": [
        "tos.html",
        "privacy.html"
      ],
      "maps_to": "legal.last_updated"
    },
    {
      "token": "[CLIENT: Insert exact satisfaction-guarantee terms here ...]",
      "found_in": [
        "tos.html"
      ],
      "maps_to": "legal.clauses[4].clause_body"
    },
    {
      "token": "[CLIENT: Insert payment terms here ...]",
      "found_in": [
        "tos.html"
      ],
      "maps_to": "legal.clauses[5].clause_body"
    },
    {
      "token": "<!-- TODO: swap src for real logo file -->",
      "found_in": [
        "home.html"
      ],
      "maps_to": "logo_image"
    },
    {
      "token": "<!-- TODO: swap hero.jpg for provided blue-hour diptych -->",
      "found_in": [
        "home.html"
      ],
      "maps_to": "hero_image"
    }
  ],
  "structured_data": {
    "LocalBusiness": {
      "pages": [
        "home",
        "area_detail x10"
      ],
      "fields": [
        "@id",
        "name",
        "alternateName",
        "description",
        "url",
        "telephone",
        "email",
        "image",
        "logo",
        "address(PostalAddress)",
        "geo(GeoCoordinates)",
        "openingHoursSpecification",
        "areaServed",
        "priceRange",
        "hasCredential"
      ],
      "defects": [
        "All 11 pages emit the SAME @id (https://jkqualityelectric.com/#business) with DIFFERENT geo coordinates and different areaServed — entity conflict.",
        "No aggregateRating / review node anywhere despite a visible reviews section.",
        "Area-page image/logo use relative mockup paths (/jk-quality-electric/mockup/images/...) that break at the production origin."
      ]
    },
    "FAQPage": {
      "pages": [
        "home (4 Q)",
        "faq (8 Q in JSON-LD vs 9 rendered — MISMATCH)",
        "area_detail x10 (3 Q each)"
      ]
    },
    "BreadcrumbList": {
      "pages": [
        "area_detail x10"
      ],
      "depth": 3
    },
    "Service": {
      "pages": [
        "services"
      ],
      "fields": [
        "provider(LocalBusiness)",
        "areaServed[10]",
        "serviceType[6]"
      ]
    },
    "ContactPage": {
      "pages": [
        "contact"
      ],
      "fields": [
        "name",
        "url",
        "mainEntity(LocalBusiness)"
      ]
    },
    "MISSING": [
      "Organization",
      "WebSite + SearchAction",
      "AggregateRating",
      "Review",
      "ImageObject on gallery",
      "Product/Offer"
    ],
    "no_jsonld_on": [
      "projects",
      "why-us",
      "tos",
      "privacy",
      "areas index"
    ]
  },
  "seo_assets": {
    "canonical": "present and correct on all 18 pages",
    "robots_meta": "index, follow",
    "robots_txt": "Allow /, Disallow /tos.html and /privacy.html, sitemap declared",
    "sitemap": {
      "url_count": 17,
      "note": "omits tos.html and privacy.html by design; includes /areas/ index"
    },
    "open_graph": [
      "og:type",
      "og:title",
      "og:description",
      "og:url",
      "og:image"
    ],
    "twitter_card": "NOT PRESENT",
    "manifest": "present (PWA), start_url/scope still scoped to /jk-quality-electric/mockup/",
    "hreflang": "NOT PRESENT"
  }
}$json$,
  $json${
  "convention": "profile.<col> | services[<service_key>].<col> | areas[<area_slug>].<col> | context.<key>",
  "drift_rule": "A field with a source_path is compared to the fact at that path by string equality. No model call. NULL source_path = site-authored = never flagged.",
  "site_fields": {
    "business_name": {
      "derives_from": "profile.legal_name"
    },
    "business_alt_name": {
      "derives_from": "profile.alternate_name"
    },
    "description": {
      "derives_from": "profile.description"
    },
    "phone_e164": {
      "derives_from": "profile.phone"
    },
    "phone_display": {
      "derives_from": "profile.phone"
    },
    "email": {
      "derives_from": "profile.email"
    },
    "street_address": {
      "derives_from": "profile.street_address"
    },
    "address_locality": {
      "derives_from": "profile.locality"
    },
    "address_region": {
      "derives_from": "profile.region"
    },
    "address_postal": {
      "derives_from": "profile.postal_code"
    },
    "address_country": {
      "derives_from": "profile.country"
    },
    "geo_lat": {
      "derives_from": "profile.geo_lat"
    },
    "geo_lng": {
      "derives_from": "profile.geo_lng"
    },
    "license_number": {
      "derives_from": "profile.license_number"
    },
    "license_authority": {
      "derives_from": "profile.license_authority"
    },
    "hours": {
      "derives_from": "profile.hours"
    },
    "google_business_url": {
      "derives_from": "profile.google_business_url"
    },
    "google_review_url": {
      "derives_from": "profile.google_place_id"
    },
    "social_facebook": {
      "derives_from": "profile.facebook_url"
    },
    "social_instagram": {
      "derives_from": "profile.instagram_url"
    },
    "analytics_id": {
      "derives_from": "profile.analytics_id"
    },
    "logo_image": {
      "derives_from": "profile.logo_media_id"
    },
    "hero_image": {
      "derives_from": "profile.hero_media_id"
    },
    "review_rating_avg": {
      "derives_from": "profile.google_place_id"
    },
    "review_count": {
      "derives_from": "profile.google_place_id"
    },
    "tagline": {
      "site_authored": true,
      "note": "brand line, not a fact"
    },
    "theme_color": {
      "site_authored": true,
      "note": "site skin token"
    },
    "canonical_origin": {
      "site_authored": true,
      "note": "set when the site gets a domain (Phase 2)"
    },
    "booking_url": {
      "site_authored": true,
      "note": "scheduling link; businesses.calendly_url is a partial, unreliable source"
    },
    "price_range": {
      "site_authored": true,
      "note": "no column in business_profile; operator judgement"
    },
    "years_in_business": {
      "site_authored": true,
      "note": "no column in business_profile"
    },
    "home_base_area": {
      "site_authored": true,
      "note": "no column in business_profile; prose, e.g. 'Saint Bernard Parish'"
    }
  },
  "collections": {
    "services": {
      "derives_from": "services[]",
      "item_paths": {
        "service_name": "services[{service_key}].name",
        "service_blurb": "services[{service_key}].blurb",
        "service_body": "services[{service_key}].body",
        "service_bullets": "services[{service_key}].bullets",
        "service_anchor": "services[{service_key}].service_key"
      },
      "site_authored_items": {
        "service_icon": "visual choice, not a fact"
      }
    },
    "service_areas": {
      "derives_from": "areas[]",
      "item_paths": {
        "area_city": "areas[{area_slug}].city",
        "area_region": "areas[{area_slug}].region",
        "area_postal": "areas[{area_slug}].postal_code",
        "area_geo_lat": "areas[{area_slug}].geo_lat",
        "area_geo_lng": "areas[{area_slug}].geo_lng",
        "area_local_blurb": "areas[{area_slug}].local_blurb",
        "area_landmarks_blurb": "areas[{area_slug}].landmarks_blurb"
      },
      "site_authored_items": {
        "area_admin_area": "parish/county label; derive from region when present"
      },
      "required_non_derivable": [
        "area_local_blurb",
        "area_landmarks_blurb"
      ],
      "note": "These two are the ONLY differentiating copy across area pages. The 10 source pages are 92.5% word-identical after masking city/ZIP/parish. NOT NULL + non-empty CHECK at the schema level."
    },
    "differentiators": {
      "derives_from": "context.key_differentiators",
      "note": "business_context.key_differentiators is a flat string[]; the template needs {diff_headline, diff_body}. businesses.why_us is already [{headline, body}] and is the better source. Splitting is a Phase 1B mapping decision, not a fact gap.",
      "item_paths": {
        "diff_headline": "context.key_differentiators[{i}]",
        "diff_body": "context.key_differentiators[{i}]"
      },
      "site_authored_items": {
        "diff_icon": "visual choice"
      }
    },
    "reviews": {
      "derives_from": "profile.google_place_id",
      "policy": "NEVER_GENERATED",
      "note": "textos-agent/CLAUDE.md prohibits AI-generated testimonials on FTC grounds: 'refuse and implement the empty state'. This collection renders empty until a real google_place_id is connected. No review text is ever stored or generated, in this phase or any later one.",
      "item_paths": {}
    },
    "faqs": {
      "site_authored": true,
      "note": "no business-fact table; operator-authored per site"
    },
    "projects": {
      "site_authored": true,
      "note": "photo gallery; operator-uploaded media + captions"
    },
    "nav_links": {
      "site_authored": true,
      "note": "derived from the site's own page structure, not from facts"
    }
  },
  "sections": {
    "site_authored_sections": [
      "hero_home",
      "page_hero",
      "positioning_band",
      "story_prose",
      "differentiator_band",
      "faq_teaser",
      "cta_band",
      "gallery_cta",
      "faq_footer_cta",
      "legal_notice",
      "legal_body",
      "area_hero"
    ],
    "note": "Hero copy, positioning, and per-page prose are site-authored — they are voice, not fact. Everything a LocalBusiness entity asserts (phone, address, geo, hours, license, areaServed, services) is derived and drift-checked."
  }
}$json$
)
ON CONFLICT (template_key) DO UPDATE SET
  name                 = EXCLUDED.name,
  vertical             = EXCLUDED.vertical,
  version              = EXCLUDED.version,
  section_catalog      = EXCLUDED.section_catalog,
  field_derivation_map = EXCLUDED.field_derivation_map,
  updated_at           = now();
-- NOTE: `status` is intentionally NOT overwritten on conflict. Re-running this
-- file refreshes the catalog without silently reverting an activated template
-- back to 'draft'.


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. Exactly one trades-v1 row:
--   SELECT template_key, name, vertical, version, status
--   FROM public.site_templates WHERE template_key = 'trades-v1';
--   -- expect 1 row, status = draft
--
-- 2. Catalog shape survived the round-trip:
--   SELECT jsonb_array_length(section_catalog->'page_types')        AS page_types,
--          jsonb_array_length(section_catalog->'placeholder_tokens') AS tokens,
--          jsonb_array_length(section_catalog->'global'->'site_fields') AS site_fields,
--          (SELECT count(*) FROM jsonb_object_keys(section_catalog->'global'->'collections')) AS collections
--   FROM public.site_templates WHERE template_key = 'trades-v1';
--   -- expect page_types=9, tokens=12, site_fields=29, collections=7
--
-- 3. The two non-derivable area fields are recorded as required:
--   SELECT field_derivation_map->'collections'->'service_areas'->'required_non_derivable'
--   FROM public.site_templates WHERE template_key = 'trades-v1';
--   -- expect ["area_local_blurb", "area_landmarks_blurb"]
--
-- 4. Reviews are marked never-generated:
--   SELECT field_derivation_map->'collections'->'reviews'->>'policy'
--   FROM public.site_templates WHERE template_key = 'trades-v1';
--   -- expect NEVER_GENERATED
--
-- 5. Every derived site field resolves to a known namespace:
--   SELECT key, value->>'derives_from' AS source_path
--   FROM public.site_templates,
--        jsonb_each(field_derivation_map->'site_fields')
--   WHERE template_key = 'trades-v1' AND value ? 'derives_from'
--   ORDER BY key;
--   -- expect 25 rows, every source_path starting 'profile.'
--
-- 6. Site-authored fields are explicit, not merely absent:
--   SELECT count(*) FROM public.site_templates,
--        jsonb_each(field_derivation_map->'site_fields')
--   WHERE template_key = 'trades-v1' AND value ? 'site_authored';
--   -- expect 7
-- =====================================================================
