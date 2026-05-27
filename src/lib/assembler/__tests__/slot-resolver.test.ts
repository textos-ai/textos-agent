import { describe, it, expect } from 'vitest';
import { resolveSlot, resolveSlotBindings } from '../slot-resolver';

const ctx = {
  content: {
    hero: { title: 'Hello', subtitle: 'World' },
    questions: [
      { id: 'q1', label: 'Q1' },
      { id: 'q2', label: 'Q2', options: [{ value: 'a' }, { value: 'b' }] },
    ],
  },
  computed: { total_score: 7, score_band_label: 'Building momentum' },
  business_context: {
    slug: 'idea-1', name: 'Idea Corp', operator_url: 'https://example.com/op',
  },
};

describe('resolveSlot — dotted paths', () => {
  it('resolves top-level', () => {
    const r = resolveSlot('hero', ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toEqual({ title: 'Hello', subtitle: 'World' });
  });
  it('resolves nested', () => {
    const r = resolveSlot('hero.title', ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toBe('Hello');
  });
  it('resolves array index', () => {
    const r = resolveSlot('questions[0].label', ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toBe('Q1');
  });
  it('resolves nested array index', () => {
    const r = resolveSlot('questions[1].options[1].value', ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toBe('b');
  });
});

describe('resolveSlot — layer prefixes', () => {
  it('resolves computed', () => {
    const r = resolveSlot('computed.total_score', ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toBe(7);
  });
  it('resolves business', () => {
    const r = resolveSlot('business.name', ctx);
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.value).toBe('Idea Corp');
  });
  it('defaults to content layer', () => {
    const r = resolveSlot('hero.title', ctx);
    expect(r.kind).toBe('resolved');
  });
});

describe('resolveSlot — literal placeholders', () => {
  it('substitutes cta_url_placeholder for operator_url', () => {
    const r = resolveSlot('cta_url_placeholder', ctx);
    expect(r.kind).toBe('placeholder');
    if (r.kind === 'placeholder') expect(r.value).toBe('https://example.com/op');
  });
});

describe('resolveSlot — missing', () => {
  it('returns missing for unknown path', () => {
    const r = resolveSlot('hero.nope', ctx);
    expect(r.kind).toBe('missing');
  });
  it('returns missing for out-of-range index', () => {
    const r = resolveSlot('questions[99].label', ctx);
    expect(r.kind).toBe('missing');
  });
});

describe('resolveSlotBindings', () => {
  it('resolves a binding map and collects missing slots', () => {
    const r = resolveSlotBindings({
      title: 'hero.title',
      operator: 'business.operator_url',
      nope: 'hero.nope',
    }, ctx);
    expect(r.resolved.title).toBe('Hello');
    expect(r.resolved.operator).toBe('https://example.com/op');
    expect(r.missing_slots).toEqual(['nope']);
  });
});
