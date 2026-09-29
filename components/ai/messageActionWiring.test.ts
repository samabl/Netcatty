/**
 * Wiring guards for the per-message chat actions (copy / edit / resend /
 * branch) and the compaction presentation surfaces.
 *
 * These are source-level assertions on purpose: the pieces live in four layers
 * (domain helper, useAIState mutator, side-panel handler, transcript UI), and a
 * dropped prop between them fails silently at runtime rather than at compile
 * time.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('the side panel exposes a handler for every transcript action', () => {
  const panel = read('../AIChatSidePanel.tsx');

  assert.match(panel, /onCopyMessage=\{handleCopyMessage\}/);
  assert.match(panel, /onEditMessage=\{handleEditMessage\}/);
  assert.match(panel, /onResendMessage=\{handleResendMessage\}/);
  assert.match(panel, /onBranchMessage=\{handleBranchMessage\}/);
  assert.match(panel, /onCancelMessageEdit=\{handleCancelMessageEdit\}/);
  assert.match(panel, /editingMessageId=\{editingMessage\?\.messageId \?\? null\}/);
});

test('sending while a message is being edited re-runs that turn instead', () => {
  const panel = read('../AIChatSidePanel.tsx');

  assert.match(panel, /if \(editingMessageRef\.current\) \{[\s\S]{0,200}submitEditedMessage\(/);
  assert.match(panel, /truncateSessionFromMessage\(session\.id, original\.id\)/);
});

test('resend truncates at the anchor user message before re-running it', () => {
  const panel = read('../AIChatSidePanel.tsx');

  assert.match(panel, /findResendAnchorIndex\(session\.messages, message\.id\)/);
  assert.match(panel, /truncateSessionFromMessage\(session\.id, anchor\.id\)/);
});

test('the panel receives truncate and fork from useAIState', () => {
  const support = read('../terminalLayer/TerminalLayerSupport.tsx');
  assert.match(support, /truncateSessionFromMessage=\{aiConfig\.truncateSessionFromMessage\}/);
  assert.match(support, /forkSessionFromMessage=\{aiConfig\.forkSessionFromMessage\}/);

  const state = read('../../application/state/useAIState.ts');
  assert.match(state, /const truncateSessionFromMessage = useCallback/);
  assert.match(state, /const forkSessionFromMessage = useCallback/);
  assert.match(state, /buildBranchMessages\(source\.messages, messageId\)/);
});

test('the transcript renders the action bar and every compaction surface', () => {
  const list = read('ChatMessageList.tsx');

  assert.match(list, /<MessageActionBar/);
  assert.match(list, /resolveChatMessageActions\(message, \{/);
  assert.match(list, /<CompactionBoundaryNotice/);
  assert.match(list, /<CompactionStatusChip/);
  assert.match(list, /<CompactionResultChip/);
  // The memo comparator must track the new props or actions go stale.
  for (const prop of [
    'compactionResult',
    'contextCompaction',
    'canRunMessageActions',
    'editingMessageId',
    'onCopyMessage',
    'onEditMessage',
    'onResendMessage',
    'onBranchMessage',
  ]) {
    assert.match(list, new RegExp(`if \\(prev\\.${prop} !== next\\.${prop}\\) return false;`));
  }
});

test('the composer shows an editing banner controlled by the panel', () => {
  const content = read('../AIChatPanelContent.tsx');

  assert.match(content, /data-ai-editing-message=""/);
  assert.match(content, /ai\.chat\.editBanner\.title/);
  assert.match(content, /contextCompaction=\{activeSession\?\.contextCompaction \?\? null\}/);
});
