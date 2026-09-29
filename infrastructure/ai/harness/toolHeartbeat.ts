/**
 * Long-running tool heartbeat.
 *
 * Tool execution happens inside the AI SDK's stream pipeline, so a tool that
 * blocks produces no stream part at all while it waits. The SDK's `chunkMs`
 * deadline keeps running through that window and cancels the entire turn when
 * it expires — even though the tool is healthy and still working. Netcatty
 * therefore runs tools that may block through this helper: it yields a
 * preliminary tool result every `heartbeatMs`, which re-arms the SDK's chunk
 * timer with real progress while the actual work continues underneath.
 *
 * Preliminary results are progress-only: the SDK excludes them from the step's
 * tool outputs (`stepToolOutputs`), so the model never sees them.
 *
 * The AI SDK takes the **last yielded value** as the tool output and discards a
 * generator's return value, so the real result is the final yielded value here.
 */

export interface ToolHeartbeatNotice {
  status: 'running';
  tool: string;
  elapsedMs: number;
}

export interface ToolHeartbeatOptions {
  toolName: string;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
}

interface RunState<T> {
  settled: boolean;
  failed: boolean;
  error: unknown;
  value: T | undefined;
}

function createDelay(ms: number): { done: Promise<void>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, ms);
  });
  return {
    done,
    cancel: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
  };
}

/**
 * Await `run()` while emitting heartbeat notices. The tool's real result is the
 * last value this generator yields, and a failure is rethrown as soon as the
 * tool settles, so the heartbeat never adds latency to a finished tool.
 */
export async function* runWithToolHeartbeat<T>(
  run: () => Promise<T>,
  options: ToolHeartbeatOptions,
): AsyncGenerator<ToolHeartbeatNotice | T, void, void> {
  const heartbeatMs = Number(options.heartbeatMs);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    yield await run();
    return;
  }

  const state: RunState<T> = { settled: false, failed: false, error: undefined, value: undefined };
  let notifySettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    notifySettled = resolve;
  });
  const tracked = run().then(
    (value) => {
      state.settled = true;
      state.value = value;
      notifySettled();
    },
    (error) => {
      state.settled = true;
      state.failed = true;
      state.error = error;
      notifySettled();
    },
  );

  const startedAt = Date.now();
  while (!state.settled) {
    const delay = createDelay(heartbeatMs);
    await Promise.race([delay.done, settled]);
    delay.cancel();
    if (state.settled || options.abortSignal?.aborted) break;
    yield {
      status: 'running',
      tool: options.toolName,
      elapsedMs: Date.now() - startedAt,
    };
  }

  await tracked;
  if (state.failed) throw state.error;
  yield state.value as T;
}
