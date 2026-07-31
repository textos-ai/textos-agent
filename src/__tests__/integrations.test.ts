// The provider registry's safety rules (Phase 3A, Parts A and B).
//
// The whole design rests on one claim: an operator can never put markup on a
// licensed contractor's public site. That claim is not enforced by the template
// being written carefully — it is enforced by two mechanisms that have to hold
// together, and these pin both.
//
//   1. Every field carries an ANCHORED validation pattern, so a value is
//      constrained before it is stored.
//   2. The template interpolates through renderTemplate's HTML escape, so even a
//      loosened pattern cannot produce a tag.
//
// No database: these are pure functions, and the rules are worth pinning
// independently of whether a row exists.
import { describe, it, expect } from "vitest";
import {
  validateProviderDefinition,
  validateIntegrationConfig,
  renderIntegration,
  positionConflicts,
  ProviderDefinitionError,
  IntegrationConfigError,
  MAX_PATTERN_LENGTH,
  MAX_VALUE_LENGTH,
  type Provider,
} from "../lib/site-render/integrations";

const GA4: Provider = {
  provider_key: "ga4",
  display_name: "Google Analytics 4",
  category: "analytics",
  embed_template: '<script async src="https://www.googletagmanager.com/gtag/js?id={{measurement_id}}"></script>',
  placement: "head",
  fields: [{ key: "measurement_id", label: "Measurement ID", pattern: "^G-[A-Z0-9]{4,20}$", required: true, help: null, placeholder: "G-XXXXXXXXXX" }],
  position: null,
  requires_consent: true,
  provider_domains: ["www.googletagmanager.com"],
  docs_url: null,
  active: true,
};

const VOICE: Provider = {
  ...GA4,
  provider_key: "elevenlabs-convai",
  display_name: "ElevenLabs Voice Agent",
  category: "voice",
  embed_template: '<elevenlabs-convai agent-id="{{agent_id}}"></elevenlabs-convai>',
  placement: "body_end",
  fields: [{ key: "agent_id", label: "Agent ID", pattern: "^[A-Za-z0-9_-]{8,64}$", required: true, help: null, placeholder: null }],
  position: "bottom-right",
};

describe("provider definition — the rules that make values-only true", () => {
  it("accepts a well-formed provider", () => {
    expect(() => validateProviderDefinition(GA4)).not.toThrow();
  });

  it("REFUSES a field with no validation pattern", () => {
    // The load-bearing rule. A field with no pattern is a free-text box that
    // lands inside a <script> tag.
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [{ key: "x", label: "X" }],
    })).toThrow(ProviderDefinitionError);
  });

  it("REFUSES an unanchored pattern", () => {
    // /G-[0-9]+/ matches happily INSIDE `"><script>…`, so the rest of the value
    // rides along unchecked. Anchoring is what makes a pattern a constraint.
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [{ key: "x", label: "X", pattern: "G-[0-9]+" }],
    })).toThrow(/anchored/);
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [{ key: "x", label: "X", pattern: "^G-[0-9]+" }],
    })).toThrow(/anchored/);
  });

  it("REFUSES a raw-output construct in the template", () => {
    // renderTemplate treats {{{x}}}, {{&x}} and {{slot:x}} as RAW HTML — needed
    // by the assembler, catastrophic here. Without this check the escape
    // guarantee would depend on whoever wrote the template picking the right
    // number of braces.
    for (const tpl of ['<b>{{{x}}}</b>', '<b>{{& x}}</b>', '<b>{{slot:x}}</b>']) {
      expect(() => validateProviderDefinition({
        embed_template: tpl,
        fields: [{ key: "x", label: "X", pattern: "^[a-z]+$" }],
      }), tpl).toThrow(/raw-output|escaping/);
    }
  });

  it("REFUSES a placeholder with no field behind it", () => {
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{known}}</b><i>{{typo}}</i>",
      fields: [{ key: "known", label: "K", pattern: "^[a-z]+$" }],
    })).toThrow(/typo/);
  });

  it("REFUSES an uncompilable or oversized pattern", () => {
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [{ key: "x", label: "X", pattern: "^([a-z$" }],
    })).toThrow(/not a valid regex/);
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [{ key: "x", label: "X", pattern: "^" + "a".repeat(MAX_PATTERN_LENGTH) + "$" }],
    })).toThrow(/limit is/);
  });

  it("REFUSES duplicate or badly-shaped field keys", () => {
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [
        { key: "x", label: "X", pattern: "^a$" },
        { key: "x", label: "X2", pattern: "^b$" },
      ],
    })).toThrow(/duplicate/);
    expect(() => validateProviderDefinition({
      embed_template: "<b>{{x}}</b>",
      fields: [{ key: "Not-Snake", label: "X", pattern: "^a$" }],
    })).toThrow(/lower_snake_case/);
  });
});

describe("operator config — values only", () => {
  it("accepts a value matching the pattern and rejects one that does not", () => {
    expect(validateIntegrationConfig(GA4, { measurement_id: "G-ABC1234" }))
      .toEqual({ measurement_id: "G-ABC1234" });
    expect(() => validateIntegrationConfig(GA4, { measurement_id: "not-an-id" }))
      .toThrow(IntegrationConfigError);
  });

  it("rejects an injection attempt outright — it never reaches the template", () => {
    for (const attack of [
      '"><script>alert(1)</script>',
      "G-ABC1234\"></script><script>alert(1)</script>",
      "javascript:alert(1)",
      "G-ABC1234 onload=alert(1)",
    ]) {
      expect(() => validateIntegrationConfig(GA4, { measurement_id: attack }), attack)
        .toThrow(IntegrationConfigError);
    }
  });

  it("drops keys the provider does not declare", () => {
    // An extra key cannot reach the template, so it is not stored and quietly
    // forgotten — it is not stored at all.
    expect(validateIntegrationConfig(GA4, { measurement_id: "G-ABC1234", sneaky: "<script>" }))
      .toEqual({ measurement_id: "G-ABC1234" });
  });

  it("requires a required field and caps value length", () => {
    expect(() => validateIntegrationConfig(GA4, {})).toThrow(/required/);
    expect(() => validateIntegrationConfig(
      { provider_key: "x", fields: [{ key: "v", label: "V", pattern: "^.*$" }] },
      { v: "a".repeat(MAX_VALUE_LENGTH + 1) },
    )).toThrow(/longer than/);
  });

  it("names the offending field, so the manager can point at the box", () => {
    try {
      validateIntegrationConfig(GA4, { measurement_id: "nope" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as IntegrationConfigError).field).toBe("measurement_id");
      expect((err as IntegrationConfigError).message).toContain("G-XXXXXXXXXX");
    }
  });
});

describe("rendering", () => {
  it("interpolates a validated value", () => {
    expect(renderIntegration(GA4, { measurement_id: "G-ABC1234" }))
      .toContain("gtag/js?id=G-ABC1234");
  });

  it("escapes on the way out, so a loosened pattern still cannot emit a tag", () => {
    // Belt AND braces: the pattern decides what is acceptable, the escape decides
    // what is possible. This provider's pattern is deliberately permissive to
    // prove the second mechanism works on its own.
    const loose: Provider = {
      ...GA4,
      embed_template: '<b data-x="{{v}}">{{v}}</b>',
      fields: [{ key: "v", label: "V", pattern: "^.*$", required: true, help: null, placeholder: null }],
    };
    const html = renderIntegration(loose, { v: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });
});

describe("position conflicts", () => {
  const integration = (provider: string, is_active = true) => ({
    id: provider, site_id: "s", provider, config: {}, is_active,
    status: "unverified" as const, last_verified_at: null,
  });

  it("reports two active widgets in the same corner", () => {
    const chat: Provider = { ...VOICE, provider_key: "hcp-chat", display_name: "Housecall Pro Chat", category: "chat" };
    const found = positionConflicts([VOICE, chat], [integration("elevenlabs-convai"), integration("hcp-chat")]);
    expect(found).toEqual([{ position: "bottom-right",
      providers: ["ElevenLabs Voice Agent", "Housecall Pro Chat"] }]);
  });

  it("ignores inactive ones and providers with no furniture", () => {
    const chat: Provider = { ...VOICE, provider_key: "hcp-chat", display_name: "Housecall Pro Chat" };
    expect(positionConflicts([VOICE, chat],
      [integration("elevenlabs-convai"), integration("hcp-chat", false)])).toEqual([]);
    // GA4 has position null — analytics has no corner to fight over.
    expect(positionConflicts([GA4, VOICE],
      [integration("ga4"), integration("elevenlabs-convai")])).toEqual([]);
  });
});
