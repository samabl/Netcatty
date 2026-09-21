import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyFormValues,
  formatKeyValueLines,
  formatListLines,
  fromFormValues,
  parseKeyValueLines,
  parseListLines,
  toFormValues,
  validateFormValues,
} from './externalMcpForm.ts';

test('parseKeyValueLines splits on the first "=" and drops blanks and comments', () => {
  assert.deepEqual(
    parseKeyValueLines('\n# comment\nTOKEN=abc\nURL=https://x?a=b\nBROKEN\nTOKEN=dup\n'),
    [
      { name: 'TOKEN', value: 'abc' },
      { name: 'URL', value: 'https://x?a=b' },
      { name: 'BROKEN', value: '' },
    ],
  );
  assert.deepEqual(parseKeyValueLines(''), []);
});

test('parseListLines trims, dedupes and skips comments', () => {
  assert.deepEqual(parseListLines('-y\n\nserver-files\n# note\n-y\n'), ['-y', 'server-files']);
  assert.deepEqual(parseListLines(''), []);
});

test('format helpers round-trip through parse helpers', () => {
  const entries = [{ name: 'A', value: '1' }, { name: 'B', value: '2' }];
  assert.deepEqual(parseKeyValueLines(formatKeyValueLines(entries)), entries);
  assert.deepEqual(parseListLines(formatListLines(['x', 'y'])), ['x', 'y']);
  assert.equal(formatKeyValueLines(undefined), '');
  assert.equal(formatListLines([]), '');
});

test('toFormValues / fromFormValues round-trip a stdio server', () => {
  const server = {
    id: 's1',
    name: 'Files',
    enabled: false,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'server-files'],
    cwd: '/tmp',
    env: [{ name: 'TOKEN', value: 't' }],
    autoApprove: true,
    toolAllowlist: ['read'],
  };
  const values = toFormValues(server);
  assert.equal(values.envText, 'TOKEN=t');
  assert.equal(values.argsText, '-y\nserver-files');

  const rebuilt = fromFormValues(values);
  assert.equal(rebuilt.command, 'npx');
  assert.deepEqual(rebuilt.args, ['-y', 'server-files']);
  assert.deepEqual(rebuilt.env, [{ name: 'TOKEN', value: 't' }]);
  assert.deepEqual(rebuilt.toolAllowlist, ['read']);
  assert.equal(rebuilt.autoApprove, true);
  assert.equal(rebuilt.enabled, false);
});

test('fromFormValues drops the fields that do not belong to the selected transport', () => {
  const values = { ...createEmptyFormValues('s1'), name: 'Remote', transport: 'http' as const, url: 'https://x/y', command: 'ignored', envText: 'A=1' };
  const server = fromFormValues(values);
  assert.equal(server.url, 'https://x/y');
  assert.equal(server.command, undefined);
  assert.equal(server.env, undefined);
});

test('validateFormValues reports transport-specific problems', () => {
  assert.deepEqual(validateFormValues(createEmptyFormValues('s1')), [
    'name-required',
    'command-required',
  ]);
  assert.deepEqual(
    validateFormValues({ ...createEmptyFormValues('s1'), name: 'x', transport: 'sse', url: 'ftp://x' }),
    ['url-invalid'],
  );
  assert.deepEqual(
    validateFormValues({ ...createEmptyFormValues('s1'), name: 'x', command: 'npx' }),
    [],
  );
});
