// factory-v2 — Strategy RESULT prompt + hardcoded sample answers.
//
// The LLM here is the RESULT WRITER: given a caterer's business context and a
// visitor's wizard answers, it writes the personalized result CONTENT. Per
// prompt-schema.md §2.1 the desired shape is described in prose and returned
// as plain JSON (parsed + Zod-validated downstream). The prompt explicitly
// forbids HTML and forbids naming components/layout — content only.
//
// Sample answers are the Whitmore & Boudreaux set (hardcoded — this proves the
// chain, not the wizard; the wizard is step 4).

export interface SampleAnswer {
  question: string;
  answer: string;
}

// The business whose app this is (the caterer). The VISITOR is the client
// (Whitmore & Boudreaux) filling the wizard for their event.
export const SAMPLE_BUSINESS = {
  name: 'Bayou & Board Charcuterie Co.',
  summary:
    'A South Louisiana charcuterie and grazing-table caterer specializing in ' +
    'Cajun-inflected boards and staffed grazing stations for corporate and private events.',
};

export const WHITMORE_BOUDREAUX_ANSWERS: SampleAnswer[] = [
  { question: 'Company / organization hosting the event', answer: 'Whitmore & Boudreaux' },
  { question: 'Neighborhood or venue (Greater New Orleans)', answer: 'Warehouse District, New Orleans — our office loft' },
  {
    question: 'The holiday gathering you are picturing (mood, headcount, what makes the charcuterie a talking point)',
    answer:
      'An upscale but warm client-and-team holiday gathering where the charcuterie is the centerpiece talking point.',
  },
  { question: 'Approximate guest count', answer: '60-150' },
  { question: 'Which charcuterie experience best fits the event', answer: 'A staffed grazing station with an on-site attendant' },
  { question: 'Event date', answer: 'December 18' },
  {
    question: 'Priorities / constraints (budget, dietary needs, heritage touches, past disappointments)',
    answer:
      'Several guests need solid gluten-free options; we want an authentic Cajun / South Louisiana French-heritage feel throughout.',
  },
];

export function buildStrategyLivePrompt(args: {
  business: { name: string; summary: string };
  answers: SampleAnswer[];
}): { system: string; user: string } {
  const qa = args.answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  const system = `You write a personalized event-strategy result for a visitor to "${args.business.name}" (${args.business.summary}). Write the result DIRECTLY from the visitor's answers below — it must reflect their specific situation and choices (guest count, service style, event date, venue, dietary needs, and the Cajun / South Louisiana identity they asked for). Generic advice is a failure.

You do NOT write HTML or JavaScript. You do NOT choose layout, sections counts beyond the guidance, or any component/widget — only the content fields below. Speak plainly, in a confident caterer's voice, to the client.

OUTPUT: return ONLY a JSON object — no markdown, no code fences, no prose, first character "{":
{
  "headline": "string — specific to their event",
  "tagline": "string — one supporting line under the headline",
  "sections": [ { "title": "string", "body": "string, 1-3 short paragraphs grounded in their answers" } ],   // 3 to 5 sections
  "action_items": [ "string — a concrete next step" ],   // 3 to 6 items
  "cta": { "headline": "string", "body": "string", "cta_label": "string — a button label" }
}`;

  const user = `VISITOR ANSWERS:\n${qa}\n\nWrite the personalized result now as JSON only, first character "{".`;

  return { system, user };
}
