// Minimal valid Assessment content payload. Three dimensions
// (positioning, audience, channels), 6 questions, max_score=18.

export const ASSESSMENT_CONTENT = {
  hero: {
    title: 'Marketing Readiness Audit',
    subtitle: 'A 5-minute scorecard for your marketing motion.',
  },
  questions: [
    {
      id: 'q1', step: 1, label: 'How clearly can you describe who your best customer is?',
      type: 'radio_cards', required: true, dimension: 'audience',
      options: [
        { value: 'vague', title: 'I describe them generally', points: 0 },
        { value: 'segmented', title: 'I have 2-3 segments', points: 2 },
        { value: 'icp', title: 'I have a written ICP', points: 3 },
      ],
    },
    {
      id: 'q2', step: 1, label: 'How often do you talk to customers?',
      type: 'radio_cards', required: true, dimension: 'audience',
      options: [
        { value: 'never', title: 'Rarely', points: 0 },
        { value: 'monthly', title: 'A few times a month', points: 2 },
        { value: 'weekly', title: 'Weekly', points: 3 },
      ],
    },
    {
      id: 'q3', step: 2, label: 'How would you describe your positioning?',
      type: 'radio_cards', required: true, dimension: 'positioning',
      options: [
        { value: 'unclear', title: 'Still finding it', points: 0 },
        { value: 'drafted', title: 'I have a draft', points: 2 },
        { value: 'tested', title: 'Validated by 5+ customers', points: 3 },
      ],
    },
    {
      id: 'q4', step: 2, label: 'How confident is your messaging?',
      type: 'star_rating', required: true, dimension: 'positioning',
      options: [
        { value: '1', points: 0 },
        { value: '2', points: 1 },
        { value: '3', points: 2 },
        { value: '4', points: 2 },
        { value: '5', points: 3 },
      ],
    },
    {
      id: 'q5', step: 3, label: 'How many channels are you actively using?',
      type: 'btn_check_radio', required: true, dimension: 'channels',
      options: [
        { value: '0-1', title: '0-1', points: 0 },
        { value: '2-3', title: '2-3', points: 2 },
        { value: '4+', title: '4+', points: 3 },
      ],
    },
    {
      id: 'q6', step: 3, label: 'Which channel drives the most growth?',
      type: 'radio_cards', required: true, dimension: 'channels',
      options: [
        { value: 'none', title: 'No clear winner', points: 0 },
        { value: 'a-few', title: 'A few candidates', points: 2 },
        { value: 'one', title: 'One dominant channel', points: 3 },
      ],
    },
  ],
  scoring: {
    max_score: 18,
    score_bands: [
      { min: 0, max: 6, label: 'Early stage', interpretation: 'You\'re still finding your foundation. Focus on positioning first.', color: 'warning' },
      { min: 7, max: 12, label: 'Building momentum', interpretation: 'You have the basics; the wins now come from doubling down on what\'s working.', color: 'primary' },
      { min: 13, max: 18, label: 'Strong foundation', interpretation: 'You\'ve done the hard work. Focus next on scaling what\'s proven.', color: 'success' },
    ],
    dimensions: [
      { id: 'positioning', label: 'Positioning' },
      { id: 'audience', label: 'Audience' },
      { id: 'channels', label: 'Channels' },
    ],
  },
  paywall: {
    title: 'Unlock your full report',
    body: 'Enter your email and we\'ll send your full scored report with recommendations.',
    cta_label: 'Send my report',
  },
  result: {
    score_label: 'Your marketing readiness score',
    score_subtitle: 'Out of 18',
    recommendations: [
      { title: 'Tighten your ICP', body: 'Write a one-paragraph description of your best customer.', priority: 'high' },
      { title: 'Pick one channel', body: 'Pick the channel where you have the most signal and double the time you spend there.', priority: 'medium' },
      { title: 'Talk to 5 customers', body: 'Schedule five 20-minute calls with current customers in the next two weeks.', priority: 'high' },
    ],
    cta: {
      headline: 'Want help with the highest-priority items?',
      body: 'TextOS runs the recurring work so you can focus on the meetings.',
      cta_label: 'Start free trial',
      cta_url_placeholder: 'cta_url_placeholder',
    },
  },
};
