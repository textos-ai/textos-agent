// Auto-extracted from .homer-reference/catalog-recon-report.md (R4).
// Manual additions (custom TextOS components) are appended at the bottom.

import type { ComponentCatalogEntry } from './types';


export const c_chart_bar: ComponentCatalogEntry = {
  id: 'chart-bar',
  name: 'Bar chart',
  category: 'data-viz',
  description: 'Chart.js bar chart (vertical/horizontal/stacked).',
  homer_classes: 'n/a (canvas)',
  source_page: 'charts-bar.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/charts-bar.html',
  html_template: `<div style="height:{{height|300px}};"><canvas id="{{id}}"></canvas></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Chart.js v4.4.9'],
  js_init_snippet: `new CustomChartJs({
  selector: '#{{id}}',
  options: () => ({
    type: 'bar',
    data: { labels: [...], datasets: [{ data: [...], backgroundColor: ins('chart-primary') }] }
  })
});`,
  mobile_responsive: true,
  text_mode: 'visual-only',
  text_mode_notes: 'Provide text breakdown alongside.',
  reliability_tier: 'core',
  reliability_notes: 'CustomChartJs auto re-renders on theme change. Note: ins() helper lives in app.js — needed for theme-aware colors.',
  archetype_fits: ['assessment', 'calculator'],
  capabilities: {
    when_to_use: 'Bar chart for comparing discrete categories or showing per-item magnitudes (vertical/horizontal/stacked); series colors come from the skin palette (ins(\'chart-primary\')).',
  },
};

export const c_chart_line: ComponentCatalogEntry = {
  id: 'chart-line',
  name: 'Line chart',
  category: 'data-viz',
  description: 'Chart.js line chart (trend / projection).',
  homer_classes: 'n/a (canvas)',
  source_page: 'charts-line.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/charts-line.html',
  html_template: `<div style="height:{{height|300px}};"><canvas id="{{id}}"></canvas></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Chart.js v4.4.9'],
  js_init_snippet: `new CustomChartJs({ selector: '#{{id}}', options: () => ({ type: 'line', data: {...} }) });`,
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['calculator'],
  capabilities: {
    when_to_use: 'Line chart for a trend or projection over an ordered axis (time / steps); series colors come from the skin palette.',
  },
};

export const c_chart_area: ComponentCatalogEntry = {
  id: 'chart-area',
  name: 'Area chart',
  category: 'data-viz',
  description: 'Filled line chart.',
  homer_classes: 'n/a (canvas)',
  source_page: 'charts-area.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/charts-area.html',
  html_template: `<div style="height:{{height|300px}};"><canvas id="{{id}}"></canvas></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Chart.js v4.4.9'],
  js_init_snippet: `new CustomChartJs({ selector: '#{{id}}', options: () => ({ type: 'line', data: { datasets: [{ fill: true, ... }] } }) });`,
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['calculator'],
  capabilities: {
    when_to_use: 'Filled line (area) chart for cumulative or volume-over-time emphasis; fill and series colors come from the skin palette.',
  },
};

export const c_chart_doughnut: ComponentCatalogEntry = {
  id: 'chart-doughnut',
  name: 'Doughnut / pie chart',
  category: 'data-viz',
  description: 'Chart.js doughnut/pie chart (composition).',
  homer_classes: 'n/a (canvas)',
  source_page: 'charts-other.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/charts-other.html',
  html_template: `<div style="height:{{height|300px}};"><canvas id="{{id}}"></canvas></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Chart.js v4.4.9'],
  js_init_snippet: `new CustomChartJs({ selector: '#{{id}}', options: () => ({ type: 'doughnut', data: {...}, options: { cutout: '65%' } }) });`,
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['assessment', 'calculator'],
  capabilities: {
    when_to_use: 'Doughnut/pie chart for part-to-whole composition (a small number of slices); slice colors come from the skin palette.',
  },
};

export const c_chart_radar: ComponentCatalogEntry = {
  id: 'chart-radar',
  name: 'Radar chart',
  category: 'data-viz',
  description: 'Chart.js radar chart (multi-dimensional breakdown). Ideal for assessment category scores.',
  homer_classes: 'n/a (canvas)',
  source_page: 'charts-other.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/charts-other.html',
  html_template: `<div style="height:{{height|350px}};"><canvas id="{{id}}"></canvas></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Chart.js v4.4.9'], // free-text (Pipeline B) — UNCHANGED
  vendor_scripts: ['custom-chartjs'], // factory-v2 registry id: Chart (base) + CustomChartJs (app.js)
  js_init_snippet: `new CustomChartJs({ selector: '#{{id}}', options: () => ({ type: 'radar', data: { labels: [...], datasets: [{ data: [...], borderColor: ins('chart-primary'), backgroundColor: ins('chart-primary-rgb', 0.2) }] } }) });`,
  mobile_responsive: true,
  text_mode_notes: 'On <375px, radar labels may collide — keep ≤6 axes.',
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['assessment'],
  capabilities: {
    when_to_use: 'Radar chart for a multi-dimensional score breakdown (≤6 axes) — the Assessment category-scores visual; line/fill colors come from the skin palette.',
  },
};

export const c_chart_polar: ComponentCatalogEntry = {
  id: 'chart-polar',
  name: 'Polar-area chart',
  category: 'data-viz',
  description: 'Chart.js polarArea variant.',
  homer_classes: 'n/a (canvas)',
  source_page: 'charts-other.html',
  source_verification: 'verbatim',
  source_demo_path: '.homer-reference/charts-other.html',
  html_template: `<div style="height:{{height|300px}};"><canvas id="{{id}}"></canvas></div>`,
  fillable_slots: ['id', 'height'],
  js_init: 'manual',
  js_dependencies: ['Chart.js v4.4.9'],
  mobile_responsive: true,
  text_mode: 'visual-only',
  reliability_tier: 'core',
  archetype_fits: ['assessment'],
  capabilities: {
    when_to_use: 'Polar-area chart for comparing magnitudes across categories where each slice shares the same angle but varies by radius; colors come from the skin palette.',
  },
};

export const DATA_VIZ_COMPONENTS: ComponentCatalogEntry[] = [
  c_chart_bar,
  c_chart_line,
  c_chart_area,
  c_chart_doughnut,
  c_chart_radar,
  c_chart_polar,
];
