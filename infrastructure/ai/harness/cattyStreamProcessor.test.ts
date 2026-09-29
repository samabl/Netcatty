import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tool } from 'ai';
import { z } from 'zod';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { processCattyStream, shouldEmitAgentEventsForStreamChunk } from './turnDrivers/cattyStreamProcessor';
import { createInitialCattyRuntimeContext } from './cattyRuntimeContext';
import { runWithToolHeartbeat } from './toolHeartbeat';
import { createCattyToolsFromCatalog } from './capabilityTools';
import type { CattyToolsBundle } from './capabilityTools';
import type { AgentEvent } from './types';
import type { ChatMessage } from '../types';

describe('shouldEmitAgentEventsForStreamChunk', () => {
  it('suppresses trace events for SDK internal stream-state errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('reasoning part abc not found'),
      }),
      false,
    );
  });

  it('still emits trace events for real stream errors', () => {
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({
        type: 'error',
        error: new Error('Provider returned HTTP 500'),
      }),
      true,
    );
    assert.equal(
      shouldEmitAgentEventsForStreamChunk({ type: 'text-delta', text: 'hi' }),
      true,
    );
  });
});

describe('processCattyStream reasoning continuation', () => {
  it('persists reasoning encrypted content delivered on reasoning-end', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'reasoning-start',
              id: 'r1',
              providerMetadata: { openai: { itemId: 'rs_1' } },
            },
            {
              type: 'reasoning-delta',
              id: 'r1',
              delta: 'thinking',
              providerMetadata: { openai: { itemId: 'rs_1' } },
            },
            {
              type: 'reasoning-end',
              id: 'r1',
              providerMetadata: {
                openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-abc' },
              },
            },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });

    const messages = new Map<string, ChatMessage>();
    messages.set('assistant-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 0,
    });
    const ui = {
      addMessageToSession: (sessionId: string, message: ChatMessage) => {
        messages.set(message.id, message);
      },
      updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
        const message = messages.get(messageId);
        if (message) messages.set(messageId, updater(message));
      },
    };

    await processCattyStream({
      streamSessionId: 'session-1',
      model,
      systemPrompt: 'test',
      toolsBundle: { tools: {}, toolsContext: {} },
      sdkMessages: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
      currentAssistantMsgId: 'assistant-1',
      maxIterations: 1,
      runtimeContext: createInitialCattyRuntimeContext({
        chatSessionId: 'session-1',
        turnId: 'turn-1',
        permissionMode: 'auto',
        scopeType: 'terminal',
      }),
      ui,
    });

    const continuation = messages.get('assistant-1')?.providerContinuation;
    const encryptedContent = continuation?.reasoningParts?.at(-1)?.providerOptions?.openai
      ?.reasoningEncryptedContent;
    assert.equal(encryptedContent, 'enc-abc');
    assert.match(continuation?.reasoningParts?.map(part => part.text).join('') ?? '', /thinking/);
  });
});

const STREAM_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The processor coalesces streamed text through requestAnimationFrame, which
// only exists in the renderer. Back it with timers so assistant text flushes.
const rafHost = globalThis as {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};
rafHost.requestAnimationFrame ??= (callback) => Number(setTimeout(callback, 0));
rafHost.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

/** First model call asks for a tool; later calls just answer with text. */
function createToolThenTextModel(toolName = 'slow_tool', input: Record<string, unknown> = {}) {
  let callCount = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-input-start', id: 'call-1', toolName },
              { type: 'tool-input-delta', id: 'call-1', delta: JSON.stringify(input) },
              { type: 'tool-input-end', id: 'call-1' },
              { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: STREAM_USAGE },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'tool finished' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: STREAM_USAGE },
          ],
        }),
      };
    },
  });
}

/** A tool that blocks like `scripts_run` on a script full of `nct.sleep`. */
function createSlowTool(options: { sleepMs: number; heartbeatMs?: number }) {
  return tool({
    description: 'slow test tool',
    inputSchema: z.object({}),
    execute: async function* () {
      const run = async () => {
        await delay(options.sleepMs);
        return 'slow-result';
      };
      if (options.heartbeatMs == null) {
        return await run();
      }
      yield* runWithToolHeartbeat(run, { toolName: 'slow_tool', heartbeatMs: options.heartbeatMs });
    },
  });
}

function createUiHarness() {
  const messages = new Map<string, ChatMessage>();
  const assistant: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 0,
  };
  messages.set(assistant.id, assistant);
  const ui = {
    addMessageToSession: (_sessionId: string, message: ChatMessage) => {
      messages.set(message.id, message);
    },
    updateMessageById: (_sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
      const message = messages.get(messageId);
      if (message) messages.set(messageId, updater(message));
    },
  };
  return { messages, ui };
}

async function runProcessor(options: {
  model: MockLanguageModelV4;
  toolsBundle: CattyToolsBundle;
  responseIdleTimeoutMs: number;
  signal?: AbortSignal;
  onAgentEvent?: (event: AgentEvent) => void;
  abortAfterMs?: number;
  controller?: AbortController;
}) {
  const { messages, ui } = createUiHarness();
  const events: AgentEvent[] = [];
  const run = processCattyStream({
    streamSessionId: 'session-1',
    model: options.model,
    systemPrompt: 'test',
    toolsBundle: options.toolsBundle,
    sdkMessages: [{ role: 'user', content: 'go' }],
    signal: options.signal ?? new AbortController().signal,
    currentAssistantMsgId: 'assistant-1',
    maxIterations: 3,
    responseIdleTimeoutMs: options.responseIdleTimeoutMs,
    runtimeContext: createInitialCattyRuntimeContext({
      chatSessionId: 'session-1',
      turnId: 'turn-1',
      permissionMode: 'auto',
      scopeType: 'terminal',
    }),
    onAgentEvent: (event) => {
      events.push(event);
      options.onAgentEvent?.(event);
    },
    ui,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.abortAfterMs != null && options.controller) {
    timer = setTimeout(() => options.controller?.abort(), options.abortAfterMs);
  }
  try {
    await run;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { messages, events };
}

function toolMessages(messages: Map<string, ChatMessage>): ChatMessage[] {
  return [...messages.values()].filter((message) => message.role === 'tool');
}

function errorMessages(messages: Map<string, ChatMessage>): ChatMessage[] {
  return [...messages.values()].filter((message) => message.errorInfo != null);
}

describe('processCattyStream tool heartbeats', () => {
  it('reports the SDK chunk deadline instead of ending the turn silently', async () => {
    const { messages, events } = await runProcessor({
      model: createToolThenTextModel(),
      toolsBundle: {
        tools: { slow_tool: createSlowTool({ sleepMs: 400 }) } as unknown as CattyToolsBundle['tools'],
        toolsContext: { slow_tool: {} as CattyToolsBundle['toolsContext'][string] },
      },
      // Chunk deadline smaller than the tool's blocking time reproduces the
      // silent turn end: no heartbeats are emitted in this bundle.
      responseIdleTimeoutMs: 100,
    });

    const errors = errorMessages(messages);
    assert.equal(errors.length, 1, 'a killed turn must leave exactly one error message');
    assert.equal(errors[0]?.errorInfo?.type, 'timeout');
    assert.match(errors[0]?.errorInfo?.message ?? '', /cancelled after/i);
    assert.equal(messages.get('assistant-1')?.executionStatus, 'failed');

    const abortEvents = events.filter(
      (event) => event.type === 'error' && (event as { code?: string }).code === 'stream_aborted',
    );
    assert.equal(abortEvents.length, 1, 'the trace must record the abort');
  });

  it('keeps a blocked tool alive with preliminary heartbeats and hides them from the transcript', async () => {
    const { messages, events } = await runProcessor({
      model: createToolThenTextModel(),
      toolsBundle: {
        tools: {
          slow_tool: createSlowTool({ sleepMs: 1_200, heartbeatMs: 30 }),
        } as unknown as CattyToolsBundle['tools'],
        toolsContext: { slow_tool: {} as CattyToolsBundle['toolsContext'][string] },
      },
      // Same deadline as the failing case: only the heartbeats keep it alive.
      responseIdleTimeoutMs: 400,
    });

    assert.deepEqual(errorMessages(messages), []);

    const toolEntries = toolMessages(messages);
    assert.equal(toolEntries.length, 1, 'heartbeats must not create extra tool messages');
    assert.match(toolEntries[0]?.toolResults?.[0]?.content ?? '', /slow-result/);
    assert.equal(toolEntries[0]?.toolResults?.[0]?.isError, false);

    const assistantText = [...messages.values()]
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('');
    assert.match(assistantText, /tool finished/);
    assert.equal(
      events.some((event) => event.type === 'tool_result' && (event as { toolCallId?: string }).toolCallId === 'call-1'),
      true,
    );
  });

  it('does not report a user stop as a stream error', async () => {    const controller = new AbortController();
    const { messages, events } = await runProcessor({
      model: createToolThenTextModel(),
      toolsBundle: {
        tools: { slow_tool: createSlowTool({ sleepMs: 400 }) } as unknown as CattyToolsBundle['tools'],
        toolsContext: { slow_tool: {} as CattyToolsBundle['toolsContext'][string] },
      },
      responseIdleTimeoutMs: 100,
      signal: controller.signal,
      controller,
      abortAfterMs: 30,
    });

    assert.deepEqual(errorMessages(messages), []);
    assert.equal(
      events.some((event) => event.type === 'error' && (event as { code?: string }).code === 'stream_aborted'),
      false,
    );
  });
});

describe('processCattyStream heartbeat plumbing', () => {
  it('keeps a real catalog tool alive through the validated tool context', async () => {
    let execStarted = false;
    let execFinished = false;
    const bridge = {
      aiExec: async () => {
        execStarted = true;
        await delay(700);
        execFinished = true;
        return { ok: true, stdout: 'deployed', stderr: '', exitCode: 0 };
      },
    };
    const toolsBundle = createCattyToolsFromCatalog(
      bridge as unknown as Parameters<typeof createCattyToolsFromCatalog>[0],
      {
        sessions: [{
          sessionId: 'session-1',
          hostId: 'host-1',
          hostname: 'prod.internal',
          label: 'prod',
          protocol: 'ssh',
          connected: true,
        }],
      },
      [],
      'auto',
      undefined,
      'chat-1',
      undefined,
      undefined,
      { toolHeartbeatMs: 30 },
    );

    const { messages } = await runProcessor({
      model: createToolThenTextModel('terminal_execute', {
        sessionId: 'session-1',
        command: 'deploy',
      }),
      toolsBundle,
      // Smaller than the tool's blocking time: only the heartbeats plumbed
      // through cattyToolContextSchema can keep this turn alive.
      responseIdleTimeoutMs: 250,
    });

    assert.equal(execStarted, true);
    assert.equal(execFinished, true);
    assert.deepEqual(errorMessages(messages), []);
    const toolEntries = toolMessages(messages);
    assert.equal(toolEntries.length, 1);
    assert.match(toolEntries[0]?.toolResults?.[0]?.content ?? '', /deployed/);
  });
});
