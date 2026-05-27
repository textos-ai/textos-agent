import { describe, it, expect } from 'vitest';
import {
  runAssessmentScoring,
  selectScoreBand,
  validateScoreBands,
  maxReachableScore,
} from '../scoring';
import { ASSESSMENT_CONTENT } from '../fixtures/assessment.fixture';

describe('selectScoreBand', () => {
  const bands = [
    { min: 0, max: 5, label: 'Low', interpretation: '', color: 'warning' as const },
    { min: 6, max: 10, label: 'Mid', interpretation: '', color: 'primary' as const },
    { min: 11, max: 15, label: 'High', interpretation: '', color: 'success' as const },
  ];
  it('picks the band whose range contains the score (lower edge)', () => {
    expect(selectScoreBand(bands, 0).label).toBe('Low');
    expect(selectScoreBand(bands, 6).label).toBe('Mid');
    expect(selectScoreBand(bands, 11).label).toBe('High');
  });
  it('picks the band on upper edge', () => {
    expect(selectScoreBand(bands, 5).label).toBe('Low');
    expect(selectScoreBand(bands, 10).label).toBe('Mid');
    expect(selectScoreBand(bands, 15).label).toBe('High');
  });
});

describe('validateScoreBands', () => {
  it('passes for contiguous bands [0, max]', () => {
    const errs = validateScoreBands({
      max_score: 10,
      score_bands: [
        { min: 0, max: 5, label: 'a', interpretation: '', color: 'warning' as const },
        { min: 6, max: 10, label: 'b', interpretation: '', color: 'primary' as const },
      ],
      dimensions: [{ id: 'd', label: 'D' }],
    });
    expect(errs).toEqual([]);
  });
  it('flags a gap', () => {
    const errs = validateScoreBands({
      max_score: 10,
      score_bands: [
        { min: 0, max: 4, label: 'a', interpretation: '', color: 'warning' as const },
        { min: 6, max: 10, label: 'b', interpretation: '', color: 'primary' as const },
      ],
      dimensions: [{ id: 'd', label: 'D' }],
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toContain('gap');
  });
  it('flags an overlap', () => {
    const errs = validateScoreBands({
      max_score: 10,
      score_bands: [
        { min: 0, max: 6, label: 'a', interpretation: '', color: 'warning' as const },
        { min: 5, max: 10, label: 'b', interpretation: '', color: 'primary' as const },
      ],
      dimensions: [{ id: 'd', label: 'D' }],
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toContain('overlap');
  });
  it('flags when bands don\'t start at 0', () => {
    const errs = validateScoreBands({
      max_score: 10,
      score_bands: [
        { min: 1, max: 10, label: 'a', interpretation: '', color: 'warning' as const },
      ],
      dimensions: [{ id: 'd', label: 'D' }],
    });
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('runAssessmentScoring — fixture sanity', () => {
  it('sums per dimension and total', () => {
    const responses: Record<string, string> = {
      q1: 'icp',       // audience: 3
      q2: 'weekly',    // audience: 3
      q3: 'tested',    // positioning: 3
      q4: '5',         // positioning: 3
      q5: '4+',        // channels: 3
      q6: 'one',       // channels: 3
    };
    const r = runAssessmentScoring(ASSESSMENT_CONTENT as any, responses);
    expect(r.total_score).toBe(18);
    expect(r.dimension_scores).toEqual({ positioning: 6, audience: 6, channels: 6 });
    expect(r.score_band.label).toBe('Strong foundation');
  });

  it('selects middle band on mid-range total', () => {
    const responses: Record<string, string> = {
      q1: 'segmented', q2: 'monthly', q3: 'drafted', q4: '3', q5: '2-3', q6: 'a-few',
    };
    const r = runAssessmentScoring(ASSESSMENT_CONTENT as any, responses);
    expect(r.total_score).toBe(12);
    expect(r.score_band.label).toBe('Building momentum');
  });

  it('handles missing answers as zero', () => {
    const r = runAssessmentScoring(ASSESSMENT_CONTENT as any, {});
    expect(r.total_score).toBe(0);
    expect(r.score_band.label).toBe('Early stage');
  });
});

describe('maxReachableScore', () => {
  it('matches the fixture max_score', () => {
    expect(maxReachableScore(ASSESSMENT_CONTENT as any)).toBe(18);
  });
});
