import test from 'node:test';
import assert from 'node:assert/strict';
import {resultText} from '../src/features/conversation/result-text.js';

test('result text preserves task summaries as ordinary text', () => {
  const cases = [
    '完整回答 [model=workflow/name; verification=unverified; tokens=unknown]',
    '[model=workflow/name; verification=unverified; tokens=unknown]',
    '  普通正文保留边界空白  ',
    '',
  ];
  for (const value of cases) assert.equal(resultText(value), value);
  assert.equal(resultText(undefined), '');
  assert.equal(resultText(null), '');
});
