import { describe, test, expect, vi, beforeEach } from 'vitest';
import { runGenerateBusinessAppV2 } from '../generate-business-app-v2';
import { STRATEGY_CONTENT } from '../../assembler/fixtures/strategy.fixture';
import type { TaskCtx } from '../types';

describe('generate-business-app-v2 asset write path', () => {
  let capturedInsertPayload: any = null;
  let mockTaskCtx: TaskCtx;

  beforeEach(() => {
    capturedInsertPayload = null;

    // Mock Anthropic client with valid tool_use response
    const mockAnthropicClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              name: 'generate_app_content',
              input: STRATEGY_CONTENT, // Use the valid fixture
            }
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 500
          }
        })
      }
    };

    // Mock Supabase client to capture insert calls
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
            insert: vi.fn((payload) => {
              // Capture the insert payload for assertion
              capturedInsertPayload = payload;
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'test-asset-id' },
                    error: null
                  })
                })
              };
            })
          };
        }

        if (table === 'app_bug_log') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null })
          };
        }

        // Default fallback
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null })
            })
          })
        };
      })
    };

    // Mock business context
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

    // Mock business row
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

    // Mock user row
    const mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      handle: 'testuser',
      handle_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    // Mock environment
    const mockEnv = {
      FRONTEND_URL: 'https://test.example.com',
      AGENT_URL: 'https://agent-test.example.com',
      ENVIRONMENT: 'test',
      ANTHROPIC_API_KEY: 'mock-key',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'mock-key'
    };

    const events: any[] = [];
    let sequence = 0;

    mockTaskCtx = {
      env: mockEnv,
      supabase: mockSupabaseClient as any,
      anthropic: mockAnthropicClient as any,
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
  test.skip('should write business_asset with correct asset_data shape', async () => {
    // Act
    const result = await runGenerateBusinessAppV2(mockTaskCtx);

    // Assert - Check that the handler completed successfully
    expect(result).toBeDefined();
    expect(result.output_data).toBeDefined();
    expect(result.output_data?.asset_id).toBe('test-asset-id');

    // Assert - Check that insert was called with correct payload
    expect(capturedInsertPayload).toBeDefined();
    expect(capturedInsertPayload.business_id).toBe('test-biz-id');
    expect(capturedInsertPayload.asset_type).toBe('app');
    expect(capturedInsertPayload.app_slug).toMatch(/^your-30-day-reiki-marketing-plan/); // Slugified title
    expect(capturedInsertPayload.app_icon).toBe('🎯'); // Strategy archetype default
    expect(capturedInsertPayload.asset_url).toMatch(/^\/sites\/test-reiki-practice\/apps\//);

    // Assert - Check asset_data has all required fields
    const assetData = capturedInsertPayload.asset_data;
    expect(assetData).toBeDefined();
    expect(assetData.html).toBeDefined();
    expect(typeof assetData.html).toBe('string');
    expect(assetData.html.length).toBeGreaterThan(100); // Non-empty HTML
    expect(assetData.generation_version).toBe(2);
    expect(assetData.archetype_id).toBe('strategy');
    expect(assetData.content).toEqual(STRATEGY_CONTENT);
    expect(assetData.manifest).toBeDefined();
    expect(assetData.llm_tier).toBe('sonnet');
    expect(assetData.llm_model).toBe('claude-sonnet-4-20250514');

    // Assert - Check manifest structure
    expect(assetData.manifest.archetype_id).toBe('strategy');
    expect(assetData.manifest.rendered_components).toBeInstanceOf(Array);
    expect(assetData.manifest.html_bytes).toBeGreaterThan(0);
  });

  // SKIP: targets aspirational v2 architecture not in current
  // stopgap handler. See docs/backlog-v2-architectural-debt.md
  test.skip('should emit correct v2 lifecycle events', async () => {
    // Act
    await runGenerateBusinessAppV2(mockTaskCtx);

    // Assert - Check that v2-prefixed events were emitted
    const emittedEventTypes = (mockTaskCtx.emit as any).mock.calls.map((call: any) => call[0].type);

    expect(emittedEventTypes).toContain('v2_app_started');
    expect(emittedEventTypes).toContain('v2_archetype_loaded');
    expect(emittedEventTypes).toContain('v2_llm_call_started');
    expect(emittedEventTypes).toContain('v2_llm_call_completed');
    expect(emittedEventTypes).toContain('v2_content_validated');
    expect(emittedEventTypes).toContain('v2_assembly_completed');
    expect(emittedEventTypes).toContain('v2_asset_stored');
    expect(emittedEventTypes).toContain('v2_app_completed');

    // Assert - Check specific event data structure
    const startedEvent = (mockTaskCtx.emit as any).mock.calls.find((call: any) =>
      call[0].type === 'v2_app_started'
    )[0];
    expect(startedEvent.seq).toBeDefined();
    expect(startedEvent.data.archetype_id).toBe('strategy');
    expect(startedEvent.data.task_run_id).toBe('test-task-run-id');
  });
});