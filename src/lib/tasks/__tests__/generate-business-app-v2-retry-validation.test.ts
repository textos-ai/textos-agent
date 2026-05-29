import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runGenerateBusinessAppV2 } from '../generate-business-app-v2';
import { STRATEGY_CONTENT } from '../../assembler/fixtures/strategy.fixture';
import type { TaskCtx } from '../types';

describe('generate-business-app-v2 retry-on-validation-failure', () => {
  let mockTaskCtx: TaskCtx;

  beforeEach(() => {
    // Mock environment
    const mockEnv = {
      FRONTEND_URL: 'https://test.example.com',
      AGENT_URL: 'https://agent-test.example.com',
      ENVIRONMENT: 'test',
      ANTHROPIC_API_KEY: 'mock-key',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'mock-key'
    };

    // Mock business context and dependencies
    const mockBusinessContext = {
      id: 'test-ctx-id',
      business_id: 'test-biz-id',
      user_id: 'test-user-id',
      business_summary: 'A reiki practice',
      industry: 'wellness',
      business_model: 'service',
      target_customer: { summary: 'wellness seekers' },
      value_proposition: 'healing energy work',
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

    const mockBusiness = {
      id: 'test-biz-id',
      user_id: 'test-user-id',
      slug: 'test-reiki-practice',
      name: 'Test Reiki Practice',
      kind: 'new_idea' as const,
      existing_business_url: null,
      existing_business_data: null,
      created_at: new Date().toISOString(),
    };

    const mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      handle: 'testuser',
      handle_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const mockSupabaseClient = {
      from: vi.fn((table: string) => {
        if (table === 'task_runs') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    config: {
                      archetype_id: 'strategy',
                      description: 'Test 30-day marketing plan for reiki practice',
                      llm_tier: 'sonnet'
                    }
                  }
                })
              })
            })
          };
        }
        if (table === 'business_assets') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  like: vi.fn().mockResolvedValue({
                    data: [] // No existing apps (unique slug)
                  })
                })
              })
            }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'test-asset-id' },
                  error: null
                })
              })
            })
          };
        }
        if (table === 'app_bug_log') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null })
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null })
            })
          })
        };
      })
    };

    const events: any[] = [];
    let sequence = 0;

    mockTaskCtx = {
      env: mockEnv,
      supabase: mockSupabaseClient as any,
      anthropic: null as any, // Will be set per test
      business: mockBusiness,
      ctx: mockBusinessContext,
      user: mockUser,
      runId: 'test-run-id',
      taskRunId: 'test-task-run-id',
      nextSeq: () => ++sequence,
      emit: vi.fn(async (evt) => {
        events.push(evt);
      }),
      cfLocation: null,
    };
  });

  test('should retry on validation failure with feedback', async () => {
    // Mock invalid content that will fail validation
    const invalidContent = {
      hero: {
        title: '', // Missing required title
        subtitle: 'A marketing plan'
      },
      // Missing required fields: questions, paywall, result
    };

    // Mock Anthropic client - first response invalid, second response valid
    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'generate_app_content',
                input: invalidContent,
              }
            ],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'generate_app_content',
                input: STRATEGY_CONTENT, // Valid content on retry
              }
            ],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    expect(result).toBeDefined();
    expect(result.output_data?.asset_id).toBe('test-asset-id');

    // Should have made two LLM calls (initial + retry)
    expect(mockAnthropicClient.messages.create).toHaveBeenCalledTimes(2);

    // Check that retry call includes validation feedback
    const retryCalls = mockAnthropicClient.messages.create.mock.calls;
    expect(retryCalls[1][0].system).toContain('Your previous response failed validation');
    expect(retryCalls[1][0].system).toContain('Correct these issues and try again');
  });

  test('should include validation error in retry feedback', async () => {
    const invalidContent = {
      hero: {
        title: '', // Will cause "String must contain at least 1 character(s)" error
        subtitle: 'A marketing plan'
      }
    };

    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: 'tool_use', name: 'generate_app_content', input: invalidContent }],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
          .mockResolvedValueOnce({
            content: [{ type: 'tool_use', name: 'generate_app_content', input: STRATEGY_CONTENT }],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    expect(result).toBeDefined();

    // Check that retry system prompt contains the validation error
    const retryCall = mockAnthropicClient.messages.create.mock.calls[1][0];
    expect(retryCall.system).toContain('Your previous response failed validation');
    // Should include specific error about title length
    expect(retryCall.system).toMatch(/String must contain at least 1 character|Required/);
  });

  test('should emit narrative event for retry attempt', async () => {
    const invalidContent = {
      hero: { title: '', subtitle: 'test' }
    };

    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: 'tool_use', name: 'generate_app_content', input: invalidContent }],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
          .mockResolvedValueOnce({
            content: [{ type: 'tool_use', name: 'generate_app_content', input: STRATEGY_CONTENT }],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await runGenerateBusinessAppV2(mockTaskCtx);

    // Should have emitted a narrative event about retrying
    const narrativeEvents = (mockTaskCtx.emit as any).mock.calls
      .map((call: any) => call[0])
      .filter((evt: any) => evt.type === 'narrative');

    expect(narrativeEvents.some((evt: any) =>
      evt.text.includes('Validation failed, retrying')
    )).toBe(true);
  });

  test('should maintain tool choice on retry', async () => {
    const invalidContent = { hero: { title: '', subtitle: 'test' } };

    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: 'tool_use', name: 'generate_app_content', input: invalidContent }],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
          .mockResolvedValueOnce({
            content: [{ type: 'tool_use', name: 'generate_app_content', input: STRATEGY_CONTENT }],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await runGenerateBusinessAppV2(mockTaskCtx);

    // Both calls should have tool_choice set
    const calls = mockAnthropicClient.messages.create.mock.calls;
    expect(calls[0][0].tool_choice).toEqual({ type: "tool", name: "generate_app_content" });
    expect(calls[1][0].tool_choice).toEqual({ type: "tool", name: "generate_app_content" });
  });
});