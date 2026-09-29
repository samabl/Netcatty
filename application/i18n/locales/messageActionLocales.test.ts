import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const MESSAGE_ACTION_KEYS = [
  'ai.chat.messageAction.copy',
  'ai.chat.messageAction.edit',
  'ai.chat.messageAction.resend',
  'ai.chat.messageAction.branch',
  'ai.chat.messageAction.branchSuffix',
  'ai.chat.messageAction.branched',
  'ai.chat.messageAction.copyFailed',
  'ai.chat.editBanner.title',
  'ai.chat.editBanner.description',
  'ai.chat.editBanner.cancel',
  'ai.chat.compaction.result',
  'ai.chat.compaction.boundary',
  'ai.chat.compaction.detailMessages',
  'ai.chat.compaction.detailSaved',
  'ai.chat.compaction.detailKind',
  'ai.chat.compaction.kind.requestTooLarge',
  'ai.chat.compaction.kind.summarized',
  'ai.chat.compaction.kind.trimmed',
] as const;

test('message actions and compaction notices are localized in every supported locale', () => {
  for (const [name, messages] of Object.entries({ en, es, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    const missing = MESSAGE_ACTION_KEYS.filter(key => !messages[key]);
    assert.deepEqual(missing, [], `${name} is missing message action labels`);
  }
});
