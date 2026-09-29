import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithToolHeartbeat, type ToolHeartbeatNotice } from './toolHeartbeat';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The AI SDK consumes the last yielded value as the tool output, so the final
 * value here is the tool result and every earlier value is a heartbeat.
 */
async function drain<T>(generator: AsyncGenerator<ToolHeartbeatNotice | T, void, void>) {
  const yielded: Array<ToolHeartbeatNotice | T> = [];
  for await (const value of generator) {
    yielded.push(value);
  }
  return {
    notices: yielded.slice(0, -1) as ToolHeartbeatNotice[],
    result: yielded.at(-1) as T | undefined,
    yieldedCount: yielded.length,
  };
}

describe('runWithToolHeartbeat', () => {
  it('emits preliminary notices while a blocked tool runs, then yields its result last', async () => {
    const { notices, result } = await drain(
      runWithToolHeartbeat(
        async () => {
          await delay(150);
          return 'script finished';
        },
        { toolName: 'scripts_run', heartbeatMs: 20 },
      ),
    );

    assert.ok(notices.length >= 3, `expected several heartbeats, got ${notices.length}`);
    assert.equal(notices[0]?.status, 'running');
    assert.equal(notices[0]?.tool, 'scripts_run');
    assert.ok((notices[1]?.elapsedMs ?? 0) >= (notices[0]?.elapsedMs ?? 0));
    assert.equal(result, 'script finished');
  });

  it('does not delay a tool that finishes before the first heartbeat', async () => {
    const startedAt = Date.now();
    const { notices, result, yieldedCount } = await drain(
      runWithToolHeartbeat(async () => 'fast', { toolName: 'get_environment', heartbeatMs: 30_000 }),
    );

    assert.deepEqual(notices, []);
    assert.equal(yieldedCount, 1);
    assert.equal(result, 'fast');
    assert.ok(Date.now() - startedAt < 1_000, 'a settled tool must not wait for the interval');
  });

  it('yields the plain result when no heartbeat interval is configured', async () => {
    const { notices, result } = await drain(
      runWithToolHeartbeat(async () => 'plain', { toolName: 'sftp_read' }),
    );

    assert.deepEqual(notices, []);
    assert.equal(result, 'plain');
  });

  it('rethrows the tool error after heartbeating', async () => {
    const generator = runWithToolHeartbeat(
      async () => {
        await delay(60);
        throw new Error('script bridge unavailable');
      },
      { toolName: 'scripts_run', heartbeatMs: 10 },
    );

    await assert.rejects(
      async () => {
        for await (const _value of generator) {
          // Drain: the failure must surface through iteration.
        }
      },
      /script bridge unavailable/,
    );
  });

  it('stops heartbeating once the tool signal is aborted', async () => {
    const controller = new AbortController();
    const generator = runWithToolHeartbeat(
      async () => {
        await delay(200);
        return 'late';
      },
      { toolName: 'scripts_run', heartbeatMs: 20, abortSignal: controller.signal },
    );

    const notices: ToolHeartbeatNotice[] = [];
    let result: unknown;
    for await (const value of generator) {
      if ((value as ToolHeartbeatNotice).status === 'running') {
        notices.push(value as ToolHeartbeatNotice);
        if (notices.length === 2) controller.abort();
      } else {
        result = value;
      }
    }

    assert.equal(notices.length, 2);
    assert.equal(result, 'late');
  });
});
