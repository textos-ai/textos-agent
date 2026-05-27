// Minimal valid Strategy content payload — used by assembler.test.ts
// for end-to-end smoke and as reference material for the Brief C LLM
// prompt. Don't include anything beyond what the schema requires.

export const STRATEGY_CONTENT = {
  hero: {
    title: 'Your 30-Day Reiki Marketing Plan',
    subtitle: 'A custom marketing plan for your reiki practice.',
  },
  questions: [
    { id: 'practice-stage', step: 1, label: 'How long have you been practicing?', placeholder: 'e.g. 3 years', type: 'text', required: true },
    { id: 'current-channels', step: 1, label: 'Where do clients find you today?', placeholder: 'e.g. word of mouth', type: 'text', required: true },
    { id: 'practice-context', step: 1, label: 'Describe your practice in one paragraph.', placeholder: '', type: 'textarea', required: true, rows: 4 },
    {
      id: 'audience-preference',
      step: 2,
      label: 'Who do you most want to attract?',
      type: 'radio_cards',
      required: true,
      options: [
        { value: 'newcomers', title: 'Reiki-curious newcomers', desc: 'People who have never tried it.' },
        { value: 'returning', title: 'Returning clients', desc: 'Lapsed regulars you want back.' },
        { value: 'wellness', title: 'Wellness-minded professionals', desc: 'Yoga / massage / spa clientele.' },
      ],
    },
    {
      id: 'tone-preference',
      step: 2,
      label: 'What tone fits your practice?',
      type: 'radio_cards',
      required: true,
      options: [
        { value: 'calm', title: 'Calm + clinical' },
        { value: 'warm', title: 'Warm + personal' },
        { value: 'playful', title: 'Playful + grounded' },
      ],
    },
    { id: 'monthly-goal', step: 3, label: 'How many new clients/month would meaningfully grow your practice?', type: 'text', required: true },
    { id: 'constraints', step: 3, label: 'What constraints should we plan around? (hours/week, budget, etc.)', type: 'textarea', required: false, rows: 3 },
  ],
  paywall: {
    title: 'Your plan is ready',
    body: 'Enter your email and we\'ll send the full plan plus a printable PDF.',
    cta_label: 'Get my plan',
  },
  result: {
    plan_title: 'Your 30-Day Reiki Marketing Plan',
    intro: 'This plan focuses on attracting reiki-curious newcomers while keeping a warm, personal tone.',
    sections: [
      {
        heading: 'Week 1 — Define your story',
        body: 'Refine the one-paragraph version of your practice that you can use everywhere.',
        action_items: [
          'Write a 100-word "about" paragraph.',
          'Pick 3 testimonial quotes.',
        ],
      },
      {
        heading: 'Week 2 — Local visibility',
        body: 'Make sure people in your area can find you.',
        action_items: [
          'Set up or claim your Google Business profile.',
          'Get listed in 3 local wellness directories.',
        ],
      },
      {
        heading: 'Week 3 — First content cadence',
        body: 'Start a weekly publication rhythm that doesn\'t depend on social-platform algorithms.',
      },
      {
        heading: 'Week 4 — Convert curiosity to booking',
        body: 'Move first-time visitors from interest to a first session.',
      },
    ],
    cta: {
      headline: 'Want help executing this plan?',
      body: 'TextOS runs your weekly content + outreach so you can focus on sessions.',
      cta_label: 'Start free trial',
      cta_url_placeholder: 'cta_url_placeholder',
    },
  },
};
