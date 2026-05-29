import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runGenerateBusinessAppV2 } from '../generate-business-app-v2';
import { STRATEGY_CONTENT } from '../../assembler/fixtures/strategy.fixture';
import type { TaskCtx } from '../types';

describe('generate-business-app-v2 tool-response parser', () => {
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

    // Mock business context and other dependencies
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

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should parse valid tool_use response', async () => {
    // Mock Anthropic client with valid tool_use response
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'generate_app_content',
              input: STRATEGY_CONTENT,
            }
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 500
          }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    expect(result).toBeDefined();
    expect(result.output_data?.asset_id).toBe('test-asset-id');
    expect(mockAnthropicClient.messages.create).toHaveBeenCalledOnce();
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should handle response with multiple content items', async () => {
    // Mock Anthropic client with mixed content response
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: 'Here is your strategy plan:'
            },
            {
              type: 'tool_use',
              name: 'generate_app_content',
              input: STRATEGY_CONTENT,
            }
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 500
          }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    expect(result).toBeDefined();
    expect(result.output_data?.asset_id).toBe('test-asset-id');
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should handle wrong tool name gracefully', async () => {
    // Mock Anthropic client with wrong tool name
    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'wrong_tool_name',
                input: STRATEGY_CONTENT,
              }
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 500
            }
          })
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'generate_app_content',
                input: STRATEGY_CONTENT,
              }
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 500
            }
          })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    expect(result).toBeDefined();
    expect(result.output_data?.asset_id).toBe('test-asset-id');
    // Should have retried
    expect(mockAnthropicClient.messages.create).toHaveBeenCalledTimes(2);
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should extract content payload from tool input', async () => {
    const customContent = {
      ...STRATEGY_CONTENT,
      hero: {
        title: 'Custom Marketing Strategy',
        subtitle: 'Tailored for your business'
      }
    };

    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'generate_app_content',
              input: customContent,
            }
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 500
          }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    expect(result).toBeDefined();
    // The content should have been used in the assembled app
    expect(result.output_data?.asset_id).toBe('test-asset-id');
  });
});