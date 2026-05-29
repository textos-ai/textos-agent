import { describe, test, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  extractBusinessContext
} from '../../prompts/app-content-prompts';
import {
  StrategyContentSchema,
  AssessmentContentSchema,
  CalculatorContentSchema
} from '../../assembler/validation/schemas';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { BusinessContextRow } from '../../../services/supabase';

describe('generate-business-app-v2 prompt builder', () => {
  const mockBusinessContextRow: BusinessContextRow = {
    id: 'test-ctx-id',
    business_id: 'test-biz-id',
    user_id: 'test-user-id',
    business_summary: 'A reiki practice offering holistic healing',
    industry: 'wellness',
    business_model: 'service',
    target_customer: { summary: 'wellness-seeking professionals' },
    value_proposition: 'personalized energy healing sessions',
    brand_voice: 'calm and nurturing',
    key_differentiators: ['certified practitioner', 'holistic approach'],
    user_profile: {},
    user_research_log: [],
    market_size: {},
    competitors: [],
    market_trends: [],
    positioning_statement: null,
    financial_snapshot: {},
    customer_signals: {},
    open_questions: [],
    agent_name: null,
    telegram_chat_id: null,
    last_research_run_at: null,
    research_confidence_score: 0.8,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockDescription = '30-day reiki marketing plan';
  const mockBusiness = {
    name: 'Test Reiki Practice',
    slug: 'test-reiki-practice',
    kind: 'new_idea' as const,
  };

  test('should build system prompt with archetype guidance', () => {
    const businessContext = extractBusinessContext(mockBusinessContextRow);
    businessContext.name = mockBusiness.name;
    businessContext.kind = mockBusiness.kind;

    const systemPrompt = buildSystemPrompt(
      'strategy',
      'Personalized Strategy Plan',
      businessContext,
      mockDescription
    );

    expect(systemPrompt).toContain('Personalized Strategy Plan');
    expect(systemPrompt).toContain('Test Reiki Practice');
    expect(systemPrompt).toContain('30-day reiki marketing plan');
    expect(systemPrompt).toContain('wellness');
    expect(systemPrompt).toContain('3-5 strategy sections');
    expect(systemPrompt).toContain('concrete and specific');
    expect(systemPrompt).toContain('FORBIDDEN VOCABULARY');
  });

  test('should build user prompt with correct instruction', () => {
    const userPrompt = buildUserPrompt(mockDescription);

    expect(userPrompt).toContain('30-day reiki marketing plan');
    expect(userPrompt).toContain('generate_app_content');
  });

  test('should build Anthropic-compatible tool schema from Zod schema', () => {
    const toolSchema = zodToJsonSchema(StrategyContentSchema, {
      target: 'openApi3'
    });

    expect(toolSchema).toBeDefined();
    expect(typeof toolSchema).toBe('object');

    // Critical: Must have "type": "object" at root level for Anthropic API
    expect(toolSchema.type).toBe('object');

    // Must NOT have $ref wrapper (that causes Anthropic API errors)
    expect(toolSchema.$ref).toBeUndefined();
    expect(toolSchema.definitions).toBeUndefined();

    // Must have inline properties
    expect(toolSchema.properties?.hero).toBeDefined();
    expect(toolSchema.properties?.questions).toBeDefined();
    expect(toolSchema.properties?.paywall).toBeDefined();
    expect(toolSchema.properties?.result).toBeDefined();
    expect(toolSchema.required).toContain('hero');
    expect(toolSchema.required).toContain('questions');
  });

  test('should generate Anthropic-compatible schema for all archetypes', () => {
    const archetypes = [
      { name: 'strategy', schema: StrategyContentSchema },
      { name: 'assessment', schema: AssessmentContentSchema },
      { name: 'calculator', schema: CalculatorContentSchema }
    ];

    archetypes.forEach(({ name, schema }) => {
      const toolSchema = zodToJsonSchema(schema, {
        target: 'openApi3'
      });

      // Critical assertion: Each archetype schema must be Anthropic-compatible
      expect(toolSchema.type, `${name} archetype missing type field`).toBe('object');
      expect(toolSchema.$ref, `${name} archetype has $ref (causes API error)`).toBeUndefined();
      expect(toolSchema.definitions, `${name} archetype has definitions (should be inline)`).toBeUndefined();
      expect(toolSchema.properties, `${name} archetype missing properties`).toBeDefined();
      expect(toolSchema.required, `${name} archetype missing required array`).toBeDefined();
    });
  });

  test('should extract business context correctly', () => {
    const businessContext = extractBusinessContext(mockBusinessContextRow);

    expect(businessContext.industry).toBe('wellness');
    expect(businessContext.target_customer).toBe('wellness-seeking professionals');
    expect(businessContext.differentiators).toBe('certified practitioner, holistic approach');
    expect(businessContext.value_proposition).toBe('personalized energy healing sessions');
  });

  test('should include forbidden words warning in strategy prompt', () => {
    const businessContext = extractBusinessContext(mockBusinessContextRow);
    businessContext.name = mockBusiness.name;
    businessContext.kind = mockBusiness.kind;

    const systemPrompt = buildSystemPrompt(
      'strategy',
      'Personalized Strategy Plan',
      businessContext,
      mockDescription
    );

    expect(systemPrompt).toContain('FORBIDDEN VOCABULARY');
    expect(systemPrompt).toContain('Never use these terms: AI, agent, task');
    expect(systemPrompt).toContain('business, customer, plan, brief, build');
  });
});