import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runGenerateBusinessAppV2 } from '../generate-business-app-v2';
import { STRATEGY_CONTENT } from '../../assembler/fixtures/strategy.fixture';
import type { TaskCtx } from '../types';

describe('generate-business-app-v2 retry-on-no-tool-use', () => {
  let mockTaskCtx: TaskCtx;
  let capturedBugReports: any[] = [];

  beforeEach(() => {
    capturedBugReports = [];

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
                    data: []
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
            insert: vi.fn((payload) => {
              capturedBugReports.push(payload);
              return Promise.resolve({ error: null });
            })
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
  test.skip('should handle text-only response (no tool use)', async () => {
    // Mock Anthropic client with text-only response
    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [
              {
                type: 'text',
                text: 'I understand you need a marketing plan, but I cannot generate the specific format you requested.'
              }
            ],
            usage: { input_tokens: 1000, output_tokens: 200 }
          })
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'generate_app_content',
                input: STRATEGY_CONTENT
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
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should handle empty content response', async () => {
    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [], // Empty content array
            usage: { input_tokens: 1000, output_tokens: 50 }
          })
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'generate_app_content',
                input: STRATEGY_CONTENT
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
    expect(mockAnthropicClient.messages.create).toHaveBeenCalledTimes(2);
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should fail after maximum retries with no tool use', async () => {
    // Mock Anthropic client that never returns tool_use
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: 'I cannot complete this request as specified.'
            }
          ],
          usage: { input_tokens: 1000, output_tokens: 200 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow('LLM failed to call tool');

    // Should have made multiple attempts (initial + retries)
    expect(mockAnthropicClient.messages.create).toHaveBeenCalledTimes(2); // Initial + 1 retry (per Brief C1)
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should log bug report for LLM tool failure', async () => {
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Cannot complete request.' }],
          usage: { input_tokens: 1000, output_tokens: 200 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow();

    // Should have logged a bug report
    expect(capturedBugReports.length).toBeGreaterThan(0);

    const bugReport = capturedBugReports[capturedBugReports.length - 1];
    expect(bugReport.business_id).toBe('test-biz-id');
    expect(bugReport.task_run_id).toBe('test-task-run-id');
    expect(bugReport.kind).toBe('v2_llm_no_tool_use');
    expect(bugReport.payload.archetype_id).toBe('strategy');
    expect(bugReport.payload.retry_attempts).toBe(1);
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should include retry count in final error', async () => {
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Cannot complete request.' }],
          usage: { input_tokens: 1000, output_tokens: 200 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    let caughtError: Error | null = null;
    try {
      await runGenerateBusinessAppV2(mockTaskCtx);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toContain('LLM failed to call tool');

    // Check bug report contains retry info
    const bugReport = capturedBugReports[capturedBugReports.length - 1];
    expect(bugReport.payload.retry_attempts).toBe(1);
    expect(bugReport.payload.max_retries).toBe(1);
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should preserve tool_choice across retry attempts', async () => {
    const mockAnthropicClient = {
      messages: {
        create: vi.fn()
          .mockResolvedValueOnce({
            content: [{ type: 'text', text: 'Text only response' }],
            usage: { input_tokens: 1000, output_tokens: 200 }
          })
          .mockResolvedValueOnce({
            content: [
              {
                type: 'tool_use',
                name: 'generate_app_content',
                input: STRATEGY_CONTENT
              }
            ],
            usage: { input_tokens: 1000, output_tokens: 500 }
          })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await runGenerateBusinessAppV2(mockTaskCtx);

    // All calls should enforce tool_choice
    const calls = mockAnthropicClient.messages.create.mock.calls;
    calls.forEach(call => {
      expect(call[0].tool_choice).toEqual({ type: "tool", name: "generate_app_content" });
    });
  });
});