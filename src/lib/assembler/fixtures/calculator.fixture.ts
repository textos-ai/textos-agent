// Minimal valid Calculator content payload — freelance pricing calc.
// salary + hours_per_week + tax_rate → annual revenue, take-home, etc.

export const CALCULATOR_CONTENT = {
  hero: {
    title: 'Freelance Pricing Report',
    subtitle: 'See what your hourly rate becomes annually after taxes.',
  },
  inputs: [
    { id: 'hourly_rate',     label: 'Hourly rate ($)',         type: 'number', default_value: 100, min: 0, max: 500, step: 5, unit: '$' },
    { id: 'hours_per_week',  label: 'Billable hours / week',   type: 'range',  default_value: 25,  min: 0, max: 60, step: 1 },
    { id: 'weeks_per_year',  label: 'Working weeks / year',    type: 'number', default_value: 48,  min: 1, max: 52, step: 1 },
    { id: 'tax_rate',        label: 'Effective tax rate (%)',  type: 'range',  default_value: 25,  min: 0, max: 50, step: 1 },
  ],
  preview: {
    expression: 'hourly_rate * hours_per_week * weeks_per_year * (1 - tax_rate / 100)',
    format: 'currency',
    label: 'Annual take-home',
  },
  calculations: [
    { id: 'gross_annual',    label: 'Gross annual revenue', expression: 'hourly_rate * hours_per_week * weeks_per_year',                                     format: 'currency' },
    { id: 'taxes_owed',      label: 'Estimated taxes',       expression: 'hourly_rate * hours_per_week * weeks_per_year * (tax_rate / 100)',                  format: 'currency' },
    { id: 'take_home',       label: 'Annual take-home',      expression: 'hourly_rate * hours_per_week * weeks_per_year * (1 - tax_rate / 100)',              format: 'currency' },
    { id: 'effective_hourly', label: 'Effective hourly',      expression: 'hourly_rate * (1 - tax_rate / 100)',                                                format: 'currency' },
  ],
  paywall: {
    title: 'See the full breakdown',
    body: 'Enter your email and we\'ll send the full report including the year-over-year projection.',
    cta_label: 'Send my report',
  },
  result: {
    big_number: {
      calculation_id: 'take_home',
      label: 'Annual take-home',
      sublabel: 'After taxes',
    },
    chart: {
      type: 'bar',
      title: 'Where the money goes',
      data_source: 'calculations',
      label_path: 'label',
      value_path: 'computed_value',
    },
    analysis_sections: [
      { heading: 'How this number is calculated', body: 'Your hourly rate × billable hours × working weeks gives gross revenue; we subtract your stated tax rate to estimate take-home.' },
      { heading: 'How to grow take-home', body: 'The two highest-leverage levers are raising your rate by 10-20% on new clients and reducing non-billable hours.' },
      { heading: 'What this misses', body: 'Health insurance, retirement contributions, and software subscriptions can take another 15-20% off the top depending on your setup.' },
    ],
    cta: {
      headline: 'Want help raising your rate?',
      body: 'TextOS reviews your positioning and proposes a defensible new rate.',
      cta_label: 'Start free trial',
      cta_url_placeholder: 'cta_url_placeholder',
    },
  },
};
