import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { AISession } from '../../infrastructure/ai/types.ts';
import { getAISessionsSnapshot } from './aiSessionsStore.ts';
import { useAIState } from './useAIState.ts';

let aiApi: ReturnType<typeof useAIState> | null = null;

function Harness() {
  aiApi = useAIState();
  return <div />;
}

const SESSION_ID = 'chat-1';
const SESSION: AISession = {
  id: SESSION_ID,
  title: 'Deploy fix',
  agentId: 'catty',
  scope: { type: 'terminal', targetId: 'terminal-a', hostIds: ['host-a'] },
  messages: [
    { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
    { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
    { id: 'user-2', role: 'user', content: 'second', timestamp: 3 },
    { id: 'assistant-2', role: 'assistant', content: 'second answer', timestamp: 4 },
  ],
  contextCompaction: { summary: 'older turns', compactedMessageCount: 2 },
  externalSessionId: 'thread-1',
  createdAt: 1,
  updatedAt: 4,
};

function sessionById(id: string): AISession | undefined {
  return getAISessionsSnapshot().sessions.find((session) => session.id === id);
}

test('truncate and fork rewrite the session history from a message', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  dom.window.localStorage.setItem('netcatty_ai_sessions_v1', JSON.stringify([SESSION]));
  dom.window.localStorage.setItem('netcatty_ai_active_session_map_v1', JSON.stringify({
    'terminal:terminal-a': SESSION_ID,
  }));

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });

  assert.ok(aiApi);
  const api = aiApi as ReturnType<typeof useAIState>;

  // ── Fork keeps the prefix (inclusive) and starts a fresh runtime thread ──
  let forked: AISession | null = null;
  await act(async () => {
    forked = api.forkSessionFromMessage(SESSION_ID, 'assistant-1', { title: 'Deploy fix (branch)' });
  });
  assert.ok(forked);
  const forkedSession = forked as AISession;
  assert.equal(forkedSession.title, 'Deploy fix (branch)');
  assert.deepEqual(forkedSession.messages.map((message) => message.id), ['user-1', 'assistant-1']);
  assert.equal(forkedSession.externalSessionId, undefined);
  assert.equal(forkedSession.agentId, 'catty');
  assert.deepEqual(forkedSession.scope, SESSION.scope);
  // The fork must not mutate the source session.
  assert.deepEqual(
    sessionById(SESSION_ID)?.messages.map((message) => message.id),
    ['user-1', 'assistant-1', 'user-2', 'assistant-2'],
  );

  // ── Truncate drops the message and its suffix, and clears the thread id ──
  let removed = 0;
  await act(async () => {
    removed = api.truncateSessionFromMessage(SESSION_ID, 'user-2');
  });
  assert.equal(removed, 2);
  const truncated = sessionById(SESSION_ID);
  assert.deepEqual(truncated?.messages.map((message) => message.id), ['user-1', 'assistant-1']);
  assert.equal(truncated?.externalSessionId, undefined);
  // Summary covers messages 0..2 and the transcript is exactly that prefix.
  assert.equal(truncated?.contextCompaction?.compactedMessageCount, 2);

  // ── Truncating the whole transcript drops the stale summary ──
  await act(async () => {
    api.truncateSessionFromMessage(SESSION_ID, 'user-1');
  });
  const emptied = sessionById(SESSION_ID);
  assert.deepEqual(emptied?.messages, []);
  assert.equal(emptied?.contextCompaction, undefined);

  // ── Unknown targets are no-ops ──
  await act(async () => {
    assert.equal(api.truncateSessionFromMessage(SESSION_ID, 'missing'), 0);
    assert.equal(api.forkSessionFromMessage(SESSION_ID, 'missing'), null);
    assert.equal(api.forkSessionFromMessage('missing-session', 'user-1'), null);
  });

  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
});
