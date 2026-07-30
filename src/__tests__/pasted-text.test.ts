// The legal document formatter: escape first, then format.
import { describe, it, expect } from "vitest";
import { formatPastedText } from "../lib/site-render/sections";

describe("formatPastedText", () => {
  it("never renders pasted HTML", () => {
    const out = formatPastedText('<script>alert(1)</script>\nplain');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("turns a numbered line into a heading and the rest into paragraphs", () => {
    const out = formatPastedText("1. Overview\nThese Terms govern your use.\n\n2. Services\nWe do work.");
    expect(out).toContain('<h2 class="legal-heading">1. Overview</h2>');
    expect(out).toContain('<h2 class="legal-heading">2. Services</h2>');
    expect((out.match(/<p>/g) ?? []).length).toBe(2);
  });

  it("keeps shape when the paste has NO blank lines", () => {
    // The failure this guards: a document pasted as one run collapsed into a
    // single block because the old renderer split only on blank lines.
    const out = formatPastedText("1. Overview\nLine one.\nLine two.");
    expect(out).toContain("<h2");
    expect(out).toContain("Line one.<br />Line two.");
  });

  it("makes list items from -, * and bullets", () => {
    const out = formatPastedText("Included:\n- one\n* two\n• three");
    expect((out.match(/<li>/g) ?? []).length).toBe(3);
    expect(out).toContain('<ul class="legal-list">');
  });

  it("treats a short ALL-CAPS line as a heading but not a shouted sentence", () => {
    expect(formatPastedText("PAYMENT TERMS")).toContain("<h2");
    const long = "THIS IS A VERY LONG SHOUTED SENTENCE THAT KEEPS GOING WELL PAST SIXTY CHARACTERS INDEED";
    expect(formatPastedText(long)).not.toContain("<h2");
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(formatPastedText("")).toBe("");
    expect(formatPastedText("   \n\n  ")).toBe("");
  });
});

import { formatLegalDate } from "../lib/site-render/sections";

describe("formatLegalDate", () => {
  it("spells out a date a legal document should not show as 7/30/2026", () => {
    expect(formatLegalDate("7/30/2026")).toBe("July 30, 2026");
    expect(formatLegalDate("2026-07-30")).toBe("July 30, 2026");
    expect(formatLegalDate("12/1/2025")).toBe("December 1, 2025");
  });
  it("passes anything it cannot read through untouched", () => {
    // Inventing a date for a legal document is not something to do quietly.
    expect(formatLegalDate("Revised at launch")).toBe("Revised at launch");
    expect(formatLegalDate("13/45/2026")).toBe("13/45/2026");
    expect(formatLegalDate("  ")).toBe("");
  });
});
