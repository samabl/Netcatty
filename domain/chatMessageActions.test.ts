import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBranchMessages,
  buildForkedSessionTitle,
  canBranchChatMessage,
  canEditChatMessage,
  canResendChatMessage,
  clampContextCompactionToLength,
  findResendAnchorIndex,
  hasCopyableChatText,
  resolveChatMessageActions,
  type ChatActionMessage,
} from './chatMessageActions.ts';

const user = (id: string, content = id): ChatActionMessage => ({ id, role: 'user', content });
const assistant = (id: string, content = id, extra: Partial<ChatActionMessage> = {}): ChatActionMessage => ({
  id,
  role: 'assistant',
  content,
  ...extra,
});
const tool = (id: string, toolResults: Array<{ toolCallId: string }>): ChatActionMessage => ({
  id,
  role: 'tool',
  content: '',
  toolResults,
});

test('copy only applies to messages with text', () => {
  assert.equal(hasCopyableChatText({ content: 'hello' }), true);
  assert.equal(hasCopyableChatText({ content: '   ' }), false);
  assert.equal(hasCopyableChatText({ content: undefined }), false);
});

test('edit is limited to user messages outside a stream', () => {
  assert.equal(canEditChatMessage(user('u1'), { canRunTurn: true }), true);
  assert.equal(canEditChatMessage(assistant('a1'), { canRunTurn: true }), false);
  assert.equal(canEditChatMessage(user('u1'), { canRunTurn: true, isStreaming: true }), false);
});

test('resend and branch need a settled turn and a configured agent', () => {
  assert.equal(canResendChatMessage(assistant('a1'), { canRunTurn: true }), true);
  assert.equal(canResendChatMessage(assistant('a1'), { canRunTurn: false }), false);
  assert.equal(canResendChatMessage(assistant('a1'), { canRunTurn: true, isStreaming: true }), false);
  assert.equal(canBranchChatMessage(user('u1')), true);
  assert.equal(canBranchChatMessage(tool('t1', [])), false);
});

test('streaming keeps only copy in the action list', () => {
  assert.deepEqual(
    resolveChatMessageActions(user('u1'), { canRunTurn: true, isStreaming: true }),
    ['copy'],
  );
  assert.deepEqual(
    resolveChatMessageActions(user('u1'), { canRunTurn: true }),
    ['copy', 'edit', 'resend', 'branch'],
  );
  assert.deepEqual(
    resolveChatMessageActions(assistant('a1'), { canRunTurn: true }),
    ['copy', 'resend', 'branch'],
  );
  assert.deepEqual(resolveChatMessageActions({ id: 'e1', role: 'assistant', content: '' }), []);
});

test('resend walks back from an assistant/tool turn to its user message', () => {
  const messages = [
    user('u1'),
    assistant('a1'),
    tool('t1', [{ toolCallId: 'call-1' }]),
    assistant('a2'),
    user('u2'),
    assistant('a3'),
  ];
  assert.equal(findResendAnchorIndex(messages, 'a1'), 0);
  assert.equal(findResendAnchorIndex(messages, 't1'), 0);
  assert.equal(findResendAnchorIndex(messages, 'a3'), 4);
  assert.equal(findResendAnchorIndex(messages, 'u2'), 4);
  assert.equal(findResendAnchorIndex(messages, 'missing'), -1);
});

test('resend anchor refuses to cross a system message', () => {
  const messages = [{ id: 's1', role: 'system', content: 'sys' }, assistant('a1')];
  assert.equal(findResendAnchorIndex(messages, 'a1'), -1);
});

test('branch keeps messages up to and including the fork point', () => {
  const messages = [user('u1'), assistant('a1'), tool('t1', [{ toolCallId: 'call-1' }])];
  const branch = buildBranchMessages(messages, 'a1');
  assert.deepEqual(branch?.map((message) => message.id), ['u1', 'a1']);
});

test('branch drops trailing orphan tool results', () => {
  const messages = [
    user('u1'),
    assistant('a1', 'answer', { toolCalls: [{ id: 'call-1' }] }),
    tool('t1', [{ toolCallId: 'call-1' }]),
  ];
  const branch = buildBranchMessages(messages, 't1');
  assert.deepEqual(branch?.map((message) => message.id), ['u1', 'a1']);
});

test('branch strips tool calls the fork cannot resolve', () => {
  const messages = [
    user('u1'),
    assistant('a1', 'answer', {
      toolCalls: [{ id: 'call-resolved' }, { id: 'call-open' }],
      executionStatus: 'running',
      statusText: 'ai.chat.compactingContext',
    }),
    tool('t1', [{ toolCallId: 'call-resolved' }]),
  ];
  // Fork at the assistant turn: the tool result lives after the fork point, so
  // neither call resolves and both must be dropped.
  const branch = buildBranchMessages(messages, 'a1');
  assert.equal(branch?.length, 2);
  const forkedAssistant = branch?.[1];
  assert.equal(forkedAssistant?.toolCalls, undefined);
  assert.equal(forkedAssistant?.executionStatus, undefined);
  assert.equal(forkedAssistant?.statusText, '');
});

test('branch keeps resolved tool calls and drops only the open ones', () => {
  const messages = [
    user('u1'),
    assistant('a1', '', { toolCalls: [{ id: 'call-resolved' }] }),
    tool('t1', [{ toolCallId: 'call-resolved' }]),
    assistant('a2', '', { toolCalls: [{ id: 'call-resolved' }, { id: 'call-open' }] }),
  ];
  const branch = buildBranchMessages(messages, 'a2');
  assert.deepEqual(branch?.[3].toolCalls, [{ id: 'call-resolved' }]);
});

test('branch keeps a fully resolved tool call pair intact', () => {
  const messages = [
    user('u1'),
    assistant('a1', '', { toolCalls: [{ id: 'call-1' }] }),
    tool('t1', [{ toolCallId: 'call-1' }]),
    assistant('a2', 'done'),
  ];
  const branch = buildBranchMessages(messages, 'a2');
  assert.deepEqual(branch?.map((message) => message.id), ['u1', 'a1', 't1', 'a2']);
});

test('branch returns null for an unknown or empty fork point', () => {
  assert.equal(buildBranchMessages([user('u1')], 'missing'), null);
  assert.equal(buildBranchMessages([tool('t1', [])], 't1'), null);
});

test('forked session titles stay within the history row budget', () => {
  assert.equal(buildForkedSessionTitle('Deploy fix', '(branch)'), 'Deploy fix (branch)');
  assert.equal(buildForkedSessionTitle('', 'New Chat (branch)'), 'New Chat (branch)');
  const long = buildForkedSessionTitle('x'.repeat(200), '(branch)', 40);
  assert.equal(long.length, 40);
});

test('compaction summaries are clamped to the surviving transcript', () => {
  const compaction = { summary: 'older turns', compactedMessageCount: 8 };
  assert.deepEqual(clampContextCompactionToLength(compaction, 20), compaction);
  assert.deepEqual(clampContextCompactionToLength(compaction, 8), compaction);
  assert.deepEqual(clampContextCompactionToLength(compaction, 5), {
    summary: 'older turns',
    compactedMessageCount: 5,
  });
  assert.equal(clampContextCompactionToLength(compaction, 0), undefined);
  assert.equal(clampContextCompactionToLength(undefined, 4), undefined);
});
