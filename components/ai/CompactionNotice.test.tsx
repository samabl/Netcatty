import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../application/i18n/I18nProvider.tsx';
import {
  CompactionBoundaryNotice,
  CompactionStatusChip,
  formatCompactionTokens,
} from './CompactionNotice.tsx';

test('compaction token labels stay readable across magnitudes', () => {
  assert.equal(formatCompactionTokens(0), '0');
  assert.equal(formatCompactionTokens(999), '999');
  assert.equal(formatCompactionTokens(1_000), '1K');
  assert.equal(formatCompactionTokens(41_000), '41K');
  assert.equal(formatCompactionTokens(128_000), '128K');
  assert.equal(formatCompactionTokens(1_500_000), '1.5M');
  // Defensive: NaN must never leak into the chip.
  assert.equal(formatCompactionTokens(Number.NaN), '0');
});

test('the boundary notice stays hidden without a summary or a count', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(CompactionBoundaryNotice, {
        compaction: { summary: '   ', compactedMessageCount: 0 },
      }),
    ),
  );
  assert.equal(markup, '');
});

test('the status chip labels the running compaction trigger', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(CompactionStatusChip, {
        compaction: { sessionId: 'chat-1', trigger: '413-retry' },
      }),
    ),
  );
  assert.match(markup, /data-ai-compaction-status=""/);
  assert.match(markup, /Request was too large/);
});
