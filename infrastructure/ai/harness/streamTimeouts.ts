import type { AIPermissionMode } from '../types';
import { CATTY_APPROVAL_HARD_DEADLINE_MS } from '../shared/approvalConstants';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const NINETY_SECONDS_MS = 90 * 1000;
const COMPACTION_TIMEOUT_MS = 90 * 1000;
const MAX_ABORT_TIMEOUT_MS = 2_147_483_647;
const MAX_TOOL_HEARTBEAT_MS = 30 * 1000;
const MIN_TOOL_HEARTBEAT_MS = 5 * 1000;

export interface BuildCattyStreamTimeoutsInput {
  permissionMode?: AIPermissionMode;
  commandTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  maxIterations?: number;
}

/**
 * Interval for the preliminary-result heartbeat that long-running tools emit
 * while they block (`runWithToolHeartbeat`). The SDK's `chunkMs` deadline keeps
 * running while a tool executes and produces no stream part, so a tool that
 * blocks longer than `chunkMs` cancels the whole turn. Staying at a third of
 * that budget leaves room for scheduling jitter.
 */
export function resolveCattyToolHeartbeatMs(chunkBudgetMs: number): number {
  if (!Number.isFinite(chunkBudgetMs) || chunkBudgetMs <= 0) return MAX_TOOL_HEARTBEAT_MS;
  return Math.max(
    MIN_TOOL_HEARTBEAT_MS,
    Math.min(MAX_TOOL_HEARTBEAT_MS, Math.floor(chunkBudgetMs / 3)),
  );
}

/** v7 streamText timeout profile for Catty multi-step agent turns. */
export function buildCattyStreamTimeouts(
  input: BuildCattyStreamTimeoutsInput = {},
) {
  // Budget the hard approval deadline so a mid-review re-arm is not cut off by toolMs.
  const approvalBudgetMs = input.permissionMode === 'confirm' ? CATTY_APPROVAL_HARD_DEADLINE_MS : 0;
  const stepCount =
    Number.isFinite(input.maxIterations) && input.maxIterations != null && input.maxIterations > 0
      ? Math.max(1, Math.floor(input.maxIterations))
      : 1;
  const commandTimeoutBudgetMs =
    Number.isFinite(input.commandTimeoutMs) && input.commandTimeoutMs > 0
      ? input.commandTimeoutMs + approvalBudgetMs + NINETY_SECONDS_MS
      : 0;
  const responseIdleTimeoutMs =
    Number.isFinite(input.responseIdleTimeoutMs) && input.responseIdleTimeoutMs > 0
      ? input.responseIdleTimeoutMs
      : TWO_MINUTES_MS;
  const responseStepBudgetMs = responseIdleTimeoutMs + NINETY_SECONDS_MS;
  // A single tool call may legitimately use the whole tool budget, so the step
  // budget must never cut a tool earlier than toolMs does. Heartbeats keep the
  // chunk timer re-armed for exactly that window.
  const toolBudgetMs = Math.max(
    CATTY_APPROVAL_HARD_DEADLINE_MS + NINETY_SECONDS_MS,
    commandTimeoutBudgetMs,
  );
  const chunkBudgetMs = Math.max(responseIdleTimeoutMs, commandTimeoutBudgetMs);
  const stepBudgetMs = Math.max(
    TEN_MINUTES_MS,
    responseStepBudgetMs + toolBudgetMs,
  );
  const totalBudgetMs = Math.max(THIRTY_MINUTES_MS, stepBudgetMs * stepCount);
  const totalMs = totalBudgetMs <= MAX_ABORT_TIMEOUT_MS ? totalBudgetMs : undefined;
  return {
    totalMs,
    stepMs: stepBudgetMs,
    chunkMs: chunkBudgetMs,
    toolMs: toolBudgetMs,
    toolHeartbeatMs: resolveCattyToolHeartbeatMs(chunkBudgetMs),
  };
}

/** Shorter timeout for LLM compaction summarize calls. */
export function buildCattyCompactionTimeout() {
  return COMPACTION_TIMEOUT_MS;
}
