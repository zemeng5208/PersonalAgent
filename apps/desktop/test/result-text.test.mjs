import test from 'node:test';
import assert from 'node:assert/strict';
import {resultText,resultMetadata} from '../src/features/conversation/result-text.js';

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

test('only the trusted Competition tail is separated from the answer', () => {
  const body='正文\n[profile=huawei_ict_agentarts; verification=unverified]';
  const summary=body+'\n[profile=huawei_ict_agentarts; verification=mock]';
  const provenance={profile:'huawei_ict_agentarts'};
  assert.equal(resultText(summary),summary);
  assert.equal(resultText(summary,provenance),body);
  assert.deepEqual(resultMetadata(summary,provenance),{profile:'huawei_ict_agentarts',verification:'mock'});
  assert.equal(resultText(summary,{profile:'local'}),summary);
  assert.equal(resultText('正文 [profile=huawei_ict_agentarts; verification=mock]',provenance),'正文 [profile=huawei_ict_agentarts; verification=mock]');
  assert.equal(resultText('正文\n[profile=huawei_ict_agentarts; verification=verified]',provenance),'正文\n[profile=huawei_ict_agentarts; verification=verified]');
});
