import test from 'node:test';
import assert from 'node:assert/strict';
import {profilePage} from '../src/features/admin/profile.js';

const escape = value => String(value);

test('profile ignores token-like result text while retaining task statistics',t=>{
  globalThis.localStorage = {getItem: () => null};
  t.after(()=>delete globalThis.localStorage);
  const tasks = [
    {taskId:'success',state:'succeeded',resultSummary:'用户或模型可控文本; tokens=987654]'},
    {taskId:'failure',state:'failed',resultSummary:'失败摘要; tokens=123]'},
    {taskId:'running',state:'running'},
  ];

  const html = profilePage({tasks},escape);

  assert.match(html, /<strong>未提供<\/strong><span>Token 总量<\/span>/);
  assert.match(html, /<strong>未提供<\/strong><span>单次峰值 Token<\/span>/);
  assert.doesNotMatch(html,/987,654|987654|<strong>123<\/strong>/);
  assert.match(html, /<strong>3<\/strong><span>本次会话任务<\/span>/);
  assert.match(html, /<span>已完成任务<\/span><b>1<\/b>/);
  assert.match(html, /<span>失败任务<\/span><b>1<\/b>/);
  assert.match(html, /Runtime 尚未提供可信 Token 用量接口；不会从任务回答内容推断用量/);
});
