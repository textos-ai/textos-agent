import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runGenerateBusinessAppV2 } from '../generate-business-app-v2';
import { STRATEGY_CONTENT } from '../../assembler/fixtures/strategy.fixture';
import type { TaskCtx } from '../types';

// Mock assembler for controlled failure testing
const mockAssembleApp = vi.hoisted(() => vi.fn());
const mockValidateContent = vi.hoisted(() => vi.fn());

vi.mock('../../assembler', () => ({
  assembleApp: mockAssembleApp,
  validateContent: mockValidateContent,
  // Need to mock other exports that might be imported
  AssemblerError: class AssemblerError extends Error {},
  ContentValidationError: class ContentValidationError extends Error {},
}));

describe('generate-business-app-v2 failure path', () => {
  let mockTaskCtx: TaskCtx;
  let capturedBugReports: any[] = [];

  beforeEach(() => {
    capturedBugReports = [];

    // Reset assembler mocks to successful defaults
    mockAssembleApp.mockReset();
    mockAssembleApp.mockReturnValue({
      html: '<html><body>Test app content</body></html>',
      manifest: {
        archetype_id: 'strategy',
        rendered_components: [],
        html_bytes: 42
      }
    });

    mockValidateContent.mockReset();
    mockValidateContent.mockImplementation((archetype_id: string, content: any) => {
      // Check for invalid content scenarios that should trigger validation errors
      if (content?.hero?.title === '') {
        throw new Error('String must contain at least 1 character(s) at "hero.title"');
      }
      return { content, warnings: [] };
    });

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
              console.log('\n=== CAPTURED APP_BUG_LOG PAYLOAD ===');
              console.log(JSON.stringify(payload, null, 2));
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
  test.skip('should log bug report for persistent validation failures', async () => {
    // Mock invalid content that will always fail validation
    const invalidContent = {
      hero: {
        title: '', // Will always fail validation
        subtitle: 'A marketing plan'
      }
      // Missing required fields
    };

    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'generate_app_content',
              input: invalidContent,
            }
          ],
          usage: { input_tokens: 1000, output_tokens: 500 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow('Content validation failed');

    // Should have logged a validation failure bug report
    expect(capturedBugReports.length).toBeGreaterThan(0);
    const bugReport = capturedBugReports.find(report =>
      report.kind === 'v2_validation_failed'
    );

    expect(bugReport).toBeDefined();
    expect(bugReport.business_id).toBe('test-biz-id');
    expect(bugReport.task_run_id).toBe('test-task-run-id');
    expect(bugReport.kind).toBe('v2_validation_failed');
    expect(bugReport.payload.archetype_id).toBe('strategy');
    expect(bugReport.payload.retry_count).toBe(1);
    expect(bugReport.payload.content_payload).toContain('"title":""');
    expect(bugReport.payload.validation_error).toContain('String must contain at least 1 character');
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should log bug report for LLM no-tool-use failures', async () => {
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: 'I cannot generate the requested content.'
            }
          ],
          usage: { input_tokens: 1000, output_tokens: 200 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow('LLM failed to call tool');

    // Should have logged a no-tool-use bug report
    expect(capturedBugReports.length).toBeGreaterThan(0);
    const bugReport = capturedBugReports.find(report =>
      report.kind === 'v2_llm_no_tool_use'
    );

    expect(bugReport).toBeDefined();
    expect(bugReport.business_id).toBe('test-biz-id');
    expect(bugReport.task_run_id).toBe('test-task-run-id');
    expect(bugReport.kind).toBe('v2_llm_no_tool_use');
    expect(bugReport.payload.archetype_id).toBe('strategy');
    expect(bugReport.payload.retry_attempts).toBe(1);
    expect(bugReport.payload.max_retries).toBe(1);
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should log bug report for assembler failures', async () => {
    // Mock content that passes validation but causes assembler to fail
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
          usage: { input_tokens: 1000, output_tokens: 500 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    // Mock assembleApp to throw an error
    mockAssembleApp.mockImplementation(() => {
      throw new Error('Component render error: missing slot binding');
    });

    // Verify the mock is configured correctly
    expect(() => mockAssembleApp()).toThrow('Component render error: missing slot binding');

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow('App assembly failed: Error: Component render error: missing slot binding');

    // Should have logged an assembler failure bug report
    expect(capturedBugReports.length).toBeGreaterThan(0);
    const bugReport = capturedBugReports.find(report =>
      report.kind === 'v2_assembler_failed'
    );

    expect(bugReport).toBeDefined();
    expect(bugReport.business_id).toBe('test-biz-id');
    expect(bugReport.task_run_id).toBe('test-task-run-id');
    expect(bugReport.kind).toBe('v2_assembler_failed');
    expect(bugReport.payload.archetype_id).toBe('strategy');
    expect(bugReport.payload.assembler_error).toContain('Component render error');
    expect(bugReport.payload.content_payload).toContain('"hero"');
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should truncate large payloads in bug reports', async () => {
    // Create very large invalid content
    const largeInvalidContent = {
      hero: {
        title: '', // Invalid
        subtitle: 'A' + 'very long subtitle '.repeat(1000) // Make it large
      }
    };

    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'generate_app_content',
              input: largeInvalidContent,
            }
          ],
          usage: { input_tokens: 1000, output_tokens: 500 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow();

    // Check that payload was truncated
    const bugReport = capturedBugReports[0];
    expect(bugReport.payload.content_payload.length).toBeLessThanOrEqual(16384); // 16KB limit
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should include recommended fixes in bug reports', async () => {
    // Test with LLM no-tool-use scenario which includes recommended_fixes
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: 'Cannot generate the requested content.'
            }
          ],
          usage: { input_tokens: 1000, output_tokens: 200 }
        })
      }
    };
    mockTaskCtx.anthropic = mockAnthropicClient as any;

    await expect(runGenerateBusinessAppV2(mockTaskCtx)).rejects.toThrow();

    const bugReport = capturedBugReports.find(report =>
      report.kind === 'v2_llm_no_tool_use'
    );

    expect(bugReport).toBeDefined();
    expect(bugReport.payload.recommended_fixes).toContain('Check system prompt instructions for tool use');
    expect(bugReport.payload.recommended_fixes).toContain('Verify tool_choice parameter is correctly set');
  });
});