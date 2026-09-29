/**
 * Pure helpers for per-message AI chat actions: copy text, edit a user
 * message, resend a turn, and fork (branch) the conversation at a message.
 *
 * Domain-only: structural types, no React, no side effects. The application
 * layer owns persistence and turn dispatch.
 */

export type ChatMessageActionId = 'copy' | 'edit' | 'resend' | 'branch';

export interface ChatActionMessage {
  id: string;
  role: string;
  content?: string;
  toolCalls?: ReadonlyArray<{ id: string }>;
  toolResults?: ReadonlyArray<{ toolCallId: string }>;
  executionStatus?: string;
  statusText?: string;
}

export interface ChatMessageActionContext {
  /** A turn is streaming for the active session; history is still being written. */
  isStreaming?: boolean;
  /** The active agent can start a turn (provider/model or external agent configured). */
  canRunTurn?: boolean;
}

/** Whether the message holds text worth copying to the clipboard. */
export function hasCopyableChatText(message: Pick<ChatActionMessage, 'content'>): boolean {
  return typeof message.content === 'string' && message.content.trim().length > 0;
}

export function canEditChatMessage(
  message: ChatActionMessage,
  context: ChatMessageActionContext = {},
): boolean {
  // Only user turns are editable — rewriting an assistant turn is a resend.
  if (message.role !== 'user') return false;
  if (context.isStreaming) return false;
  return true;
}

export function canResendChatMessage(
  message: ChatActionMessage,
  context: ChatMessageActionContext = {},
): boolean {
  if (context.isStreaming || !context.canRunTurn) return false;
  return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
}

export function canBranchChatMessage(
  message: ChatActionMessage,
  context: ChatMessageActionContext = {},
): boolean {
  if (context.isStreaming) return false;
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  // An empty assistant placeholder is an in-flight turn, not a fork point.
  return hasCopyableChatText(message) || (message.toolCalls?.length ?? 0) > 0;
}

/**
 * Ordered action list for a message. `['copy']` is all that survives while a
 * turn is streaming or before an agent is configured.
 */
export function resolveChatMessageActions(
  message: ChatActionMessage,
  context: ChatMessageActionContext = {},
): ChatMessageActionId[] {
  const actions: ChatMessageActionId[] = [];
  if (hasCopyableChatText(message)) actions.push('copy');
  if (canEditChatMessage(message, context)) actions.push('edit');
  if (canResendChatMessage(message, context)) actions.push('resend');
  if (canBranchChatMessage(message, context)) actions.push('branch');
  return actions;
}

/**
 * Index of the user message a resend should re-run from.
 *
 * Resending a user message re-runs that turn. Resending an assistant or tool
 * message regenerates the reply, so it walks back to the user turn that
 * produced it. Returns -1 when there is nothing to re-run.
 */
export function findResendAnchorIndex(
  messages: ReadonlyArray<ChatActionMessage>,
  messageId: string,
): number {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message.role === 'user') return cursor;
    if (message.role === 'system') return -1;
  }
  return -1;
}

/**
 * Messages to keep when forking the conversation at `messageId` (inclusive).
 *
 * Tool results live in their own `role: 'tool'` messages, so a naive slice can
 * strand a tool call without its result or end on an orphan tool result. The
 * fork therefore drops trailing tool carriers and strips tool calls that the
 * slice cannot resolve, and clears transient turn status.
 */
export function buildBranchMessages<T extends ChatActionMessage>(
  messages: ReadonlyArray<T>,
  messageId: string,
): T[] | null {
  const endIndex = messages.findIndex((message) => message.id === messageId);
  if (endIndex < 0) return null;

  const branch: T[] = messages.slice(0, endIndex + 1);
  // An orphan tool result is only ever trailing here.
  while (branch.length > 0 && branch[branch.length - 1].role === 'tool') branch.pop();
  if (branch.length === 0) return null;

  const resolvedToolCallIds = new Set<string>();
  for (const message of branch) {
    for (const result of message.toolResults ?? []) {
      if (result?.toolCallId) resolvedToolCallIds.add(result.toolCallId);
    }
  }

  return branch.map((message) => {
    const declaredToolCalls = message.toolCalls ?? [];
    const resolvedToolCalls = declaredToolCalls.filter(
      (toolCall) => resolvedToolCallIds.has(toolCall.id),
    );
    const shouldRewriteToolCalls = declaredToolCalls.length > resolvedToolCalls.length;
    const staleStatus = message.executionStatus === 'running'
      || message.executionStatus === 'pending'
      || message.executionStatus === 'failed'
      || message.executionStatus === 'cancelled';
    if (!shouldRewriteToolCalls && !staleStatus && !message.statusText) return message;

    return {
      ...message,
      ...(shouldRewriteToolCalls
        ? { toolCalls: resolvedToolCalls.length > 0 ? resolvedToolCalls : undefined }
        : {}),
      ...(staleStatus ? { executionStatus: undefined } : {}),
      ...(message.statusText ? { statusText: '' } : {}),
    } as T;
  });
}

/**
 * Title for a forked session: keeps the source title recognisable and stays
 * inside the history-row budget.
 */
export function buildForkedSessionTitle(
  sourceTitle: string,
  suffix: string,
  maxLength = 60,
): string {
  const base = (sourceTitle ?? '').trim();
  const decorated = base ? `${base} ${suffix}` : suffix;
  if (decorated.length <= maxLength) return decorated;
  return decorated.slice(0, maxLength).trimEnd();
}

export interface ChatContextCompactionLike {
  summary: string;
  compactedMessageCount: number;
}

/**
 * Keep a persisted compaction summary consistent with a shortened transcript.
 *
 * A summary that covered messages a truncate/fork just dropped would otherwise
 * claim more history than the transcript still has — and `buildCattySdkMessages`
 * would slice past the end of the remaining messages. Returns undefined once
 * nothing is left to anchor the summary.
 */
export function clampContextCompactionToLength<T extends ChatContextCompactionLike>(
  compaction: T | undefined,
  messageCount: number,
): T | undefined {
  if (!compaction) return undefined;
  if (messageCount <= 0) return undefined;
  if (compaction.compactedMessageCount <= messageCount) return compaction;
  return { ...compaction, compactedMessageCount: messageCount };
}
