import { describe, test, expect, vi, beforeEach } from 'vitest';
import { appendWorkLog } from '../work-log';
import type { TaskCtx } from '../tasks/types';

describe('appendWorkLog', () => {
  let mockTaskCtx: TaskCtx;
  let mockSupabaseRpc: any;

  beforeEach(() => {
    mockSupabaseRpc = vi.fn().mockResolvedValue({ error: null });

    mockTaskCtx = {
      taskRunId: 'test-task-run-id',
      env: { ENVIRONMENT: 'test' } as any,
      supabase: {
        rpc: mockSupabaseRpc
      } as any,
    } as TaskCtx;
  });

  test('should call append_to_work_log RPC with correct parameters', async () => {
    const eventType = 'v2_test_event';
    const payload = { test: 'data', count: 42 };

    await appendWorkLog(mockTaskCtx, eventType, payload);

    expect(mockSupabaseRpc).toHaveBeenCalledWith('append_to_work_log', {
      p_run_id: 'test-task-run-id',
      p_event: {
        event: eventType,
        ts: expect.any(String),
        payload: payload
      }
    });
  });

  test('should handle environment-based truncation in production', async () => {
    // Override environment to prod
    mockTaskCtx.env.ENVIRONMENT = 'prod';

    const eventType = 'v2_test_event';
    const largePayload = {
      large_field: 'x'.repeat(3000), // Larger than 2048 chars
      normal_field: 'test'
    };

    await appendWorkLog(mockTaskCtx, eventType, largePayload);

    const calledPayload = mockSupabaseRpc.mock.calls[0][1].p_event.payload;
    expect(calledPayload.large_field).toContain('...TRUNCATED');
    expect(calledPayload.normal_field).toBe('test');
  });

  test('should preserve full payload in test environment', async () => {
    const eventType = 'v2_test_event';
    const largePayload = {
      large_field: 'x'.repeat(3000),
      normal_field: 'test'
    };

    await appendWorkLog(mockTaskCtx, eventType, largePayload);

    const calledPayload = mockSupabaseRpc.mock.calls[0][1].p_event.payload;
    expect(calledPayload.large_field).toBe('x'.repeat(3000)); // No truncation in test
    expect(calledPayload.normal_field).toBe('test');
  });

  test('should handle RPC errors gracefully', async () => {
    mockSupabaseRpc.mockResolvedValue({ error: { message: 'RPC failed' } });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await appendWorkLog(mockTaskCtx, 'v2_test_event', {});

    expect(consoleSpy).toHaveBeenCalledWith(
      '[work-log] append_failed',
      expect.objectContaining({
        task_run_id: 'test-task-run-id',
        event_type: 'v2_test_event',
        error: 'RPC failed'
      })
    );

    consoleSpy.mockRestore();
  });
});