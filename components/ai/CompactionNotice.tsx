/**
 * Context-compaction surfaces for the AI chat transcript.
 *
 * Compaction is automatic on the Catty path (budget-gated pre-turn / step
 * trimming, plus a one-shot 413 retry and the manual `/compact` command).
 * These components only *present* that state — they never change when or how
 * compaction runs:
 *
 * - `CompactionStatusChip`   — a compaction is running right now.
 * - `CompactionResultChip`   — what the last compaction did (token delta).
 * - `CompactionBoundaryNotice` — the persisted summary that replaced the
 *   earlier part of a manually compacted conversation.
 */

import React, { useState } from 'react';
import { ChevronDown, Loader2, Minimize2 } from 'lucide-react';

import type {
  ActiveCompactionUi,
  CompactionResultUi,
} from '../../application/state/useAgentCompactionUi';
import { compactionStatusText } from '../../application/state/useAgentCompactionUi';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { AISessionContextCompaction } from '../../infrastructure/ai/types';
import { cn } from '../../lib/utils';

export type { CompactionResultUi };

export function formatCompactionTokens(tokens: number): string {
  const safe = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  const trim = (value: string) => (value.endsWith('.0') ? value.slice(0, -2) : value);
  if (safe >= 1_000_000) return `${trim((safe / 1_000_000).toFixed(1))}M`;
  if (safe >= 1_000) return `${trim((safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1))}K`;
  return String(Math.round(safe));
}

/** Compaction running right now, driven by the agent runtime event stream. */
export const CompactionStatusChip: React.FC<{ compaction: ActiveCompactionUi }> = ({ compaction }) => {
  const { t } = useI18n();
  const label = compactionStatusText(compaction.trigger, t);
  return (
    <div
      role="status"
      data-ai-compaction-status=""
      className="my-0.5 inline-flex items-center gap-1.5 self-start rounded-md border border-border/30 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground/70"
    >
      <Loader2 size={11} className="shrink-0 animate-spin" />
      <span>{label}</span>
    </div>
  );
};

/** Result of the most recent compaction in this session. */
export const CompactionResultChip: React.FC<{ result: CompactionResultUi }> = ({ result }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const saved = Math.max(0, result.tokensBefore - result.tokensAfter);
  const label = t('ai.chat.compaction.result')
    .replace('{before}', formatCompactionTokens(result.tokensBefore))
    .replace('{after}', formatCompactionTokens(result.tokensAfter));

  return (
    <div
      data-ai-compaction-result=""
      className="my-0.5 flex flex-col items-start gap-1 self-start"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border/30 bg-muted/20 px-2 py-1',
          'text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground',
        )}
      >
        <Minimize2 size={11} className="shrink-0" />
        <span>{label}</span>
        <ChevronDown size={11} className={cn('shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="rounded-md border border-border/25 bg-muted/10 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground/60">
          <div>{t('ai.chat.compaction.detailMessages')
            .replace('{before}', String(result.messagesBefore))
            .replace('{after}', String(result.messagesAfter))}</div>
          <div>{t('ai.chat.compaction.detailSaved').replace('{tokens}', formatCompactionTokens(saved))}</div>
          <div>{t('ai.chat.compaction.detailKind').replace('{kind}', resolveCompactionKindKey(result, t))}</div>
        </div>
      )}
    </div>
  );
};

function resolveCompactionKindKey(
  result: CompactionResultUi,
  translate: (key: string) => string,
): string {
  if (result.did413Fallback) return translate('ai.chat.compaction.kind.requestTooLarge');
  if (result.didLlmSummarize) return translate('ai.chat.compaction.kind.summarized');
  if (result.didTypedCompression) return translate('ai.chat.compaction.kind.trimmed');
  return translate('ai.chat.compaction.kind.trimmed');
}

/** Persisted summary that stands in for the compacted prefix of a session. */
export const CompactionBoundaryNotice: React.FC<{
  compaction: AISessionContextCompaction;
}> = ({ compaction }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const summary = (compaction.summary ?? '').trim();
  if (!summary && compaction.compactedMessageCount <= 0) return null;

  return (
    <div data-ai-compaction-boundary="" className="flex flex-col items-start gap-1 py-1">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/40 transition-colors hover:text-muted-foreground/70"
      >
        <Minimize2 size={11} className="shrink-0" />
        <span>{t('ai.chat.compaction.boundary').replace('{n}', String(compaction.compactedMessageCount))}</span>
        <ChevronDown size={11} className={cn('shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && summary && (
        <pre className="max-h-[220px] w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/25 bg-muted/10 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground/70 [overflow-wrap:anywhere]">
          {summary}
        </pre>
      )}
    </div>
  );
};
