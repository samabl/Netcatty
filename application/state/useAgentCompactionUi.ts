import { useEffect, useState } from 'react';
import type { ContextPrepareTrigger } from '../../infrastructure/ai/harness/types';
import { getAgentRuntime } from '../../infrastructure/ai/harness/globalAgentRuntime';
import { CATTY_COMPACTION_STATUS_KEYS } from '../../infrastructure/ai/harness/compactionStatusKeys';

export interface ActiveCompactionUi {
  sessionId: string;
  trigger: ContextPrepareTrigger;
}

export interface AgentContextUsage {
  sessionId: string;
  inputTokens: number;
  contextWindow: number;
  estimated: boolean;
}

/**
 * Presentation-only view of a completed compaction. Mirrors the fields the
 * transcript chip needs — the runtime `CompactionTrace` stays authoritative.
 */
export interface CompactionResultUi {
  sessionId: string;
  trigger: ContextPrepareTrigger;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  didLlmSummarize: boolean;
  didTypedCompression: boolean;
  did413Fallback: boolean;
}

function statusKeyForTrigger(trigger: ContextPrepareTrigger): string {
  switch (trigger) {
    case 'step':
      return CATTY_COMPACTION_STATUS_KEYS.step;
    case '413-retry':
      return CATTY_COMPACTION_STATUS_KEYS.retry;
    default:
      return CATTY_COMPACTION_STATUS_KEYS.preTurn;
  }
}

export function useAgentCompactionUi(): ActiveCompactionUi | null {
  const [active, setActive] = useState<ActiveCompactionUi | null>(null);

  useEffect(() => {
    const unsubscribe = getAgentRuntime().subscribe((event) => {
      const sessionId = event.chatSessionId ?? event.sessionId;
      if (event.type === 'compaction_start') {
        setActive({ sessionId, trigger: event.trigger });
        return;
      }
      if (event.type === 'compaction' || event.type === 'turn_end') {
        setActive((prev) => (prev?.sessionId === sessionId ? null : prev));
      }
    });
    return unsubscribe;
  }, []);

  return active;
}

export function compactionStatusText(
  trigger: ContextPrepareTrigger,
  translate: (key: string, params?: Record<string, string | number>) => string,
): string {
  return translate(statusKeyForTrigger(trigger));
}

/**
 * Result of the most recent compaction for a chat session, for presentation
 * only. Cleared when the session changes and when the next turn starts, so the
 * chip never outlives the turn it belongs to.
 */
export function useAgentCompactionResult(
  sessionId: string | null | undefined,
): CompactionResultUi | null {
  const [result, setResult] = useState<CompactionResultUi | null>(null);

  useEffect(() => {
    setResult(null);
    if (!sessionId) return undefined;

    const unsubscribe = getAgentRuntime().subscribe((event) => {
      const eventSessionId = event.chatSessionId ?? event.sessionId;
      if (eventSessionId !== sessionId) return;
      if (event.type === 'turn_start') {
        setResult((prev) => (prev?.sessionId === sessionId ? null : prev));
        return;
      }
      if (event.type !== 'compaction') return;
      const trace = event.trace;
      setResult({
        sessionId,
        trigger: trace.trigger,
        tokensBefore: trace.estimatedTokensBefore,
        tokensAfter: trace.estimatedTokensAfter,
        messagesBefore: trace.messagesBefore,
        messagesAfter: trace.messagesAfter,
        didLlmSummarize: trace.didLlmSummarize,
        didTypedCompression: trace.didTypedCompression,
        did413Fallback: trace.did413Fallback,
      });
    });
    return unsubscribe;
  }, [sessionId]);

  return result?.sessionId === sessionId ? result : null;
}

export function resolveCompactionStatusText(
  statusText: string | undefined,
  translate: (key: string) => string,
): string | undefined {
  if (!statusText) return undefined;
  if (statusText.startsWith('ai.')) return translate(statusText);
  return statusText;
}

export function useAgentContextUsage(sessionId: string | null | undefined): AgentContextUsage | null {
  const [usage, setUsage] = useState<AgentContextUsage | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setUsage(null);
      return undefined;
    }

    const unsubscribe = getAgentRuntime().subscribe((event) => {
      const eventSessionId = event.chatSessionId ?? event.sessionId;
      if (eventSessionId !== sessionId || event.type !== 'context_snapshot') return;
      const snapshot = event.snapshot;
      if (
        typeof snapshot.contextWindow !== 'number'
        || typeof snapshot.estimatedInputTokens !== 'number'
      ) {
        return;
      }
      setUsage({
        sessionId,
        inputTokens: Math.max(0, snapshot.estimatedInputTokens),
        contextWindow: Math.max(1, snapshot.contextWindow),
        estimated: true,
      });
    });
    return unsubscribe;
  }, [sessionId]);

  return usage?.sessionId === sessionId ? usage : null;
}
