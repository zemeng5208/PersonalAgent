import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LayaTriageService} from '../dist/index.js';

const answer = (choice, probabilities) => ({choice, probabilities,
  answer_confidence: Math.max(...Object.values(probabilities)), confidence: 0.42});

for (const batching of ['multi_question', 'multi_state']) {
  const classify = async ({impactProbability = 0.51, highImpact = false, options = {}} = {}) => {
    const answers = {
      category_0: answer('work', {work: 0.9, news: 0.1}),
      impact_0: answer('routine', {routine: impactProbability, high_impact: 1 - impactProbability}),
    };
    const inference = {
      async infer() { return {answers}; },
      async inferBatch(payload) {
        return {items: payload.items.map(item => ({requestId: item.requestId, result: {answers}}))};
      },
    };
    const service = new LayaTriageService(inference, {batching, ...options});
    const results = await service.classify({
      messages: [{source: 'mail', messageId: 'impact-uncertain', sourceRevision: '1',
        text: 'Synthetic work update requiring impact assessment', highImpact}],
      labels: {work: 'Work', news: 'News'},
      deadline: new Date(Date.now() + 10_000).toISOString(),
      signal: new AbortController().signal,
    });
    return results[0];
  };

  test(`${batching}: confident category cannot suppress uncertain impact`, async () => {
    const result = await classify();
    assert.equal(result.route, 'review');
    assert.equal(result.reason, 'uncertain');
    assert.equal(result.abstained, true);
    assert.equal(result.label, null);
    assert.equal(result.candidateLabel, 'work');
  });

  test(`${batching}: impact margin is enforced independently of probability`, async () => {
    const result = await classify({impactProbability: 0.55,
      options: {minimumAnswerProbability: 0.5, minimumMargin: 0.2}});
    assert.equal(result.route, 'review');
    assert.equal(result.abstained, true);
    assert.equal(result.label, null);
  });

  test(`${batching}: explicit impact is never downgraded and confident routine still groups`, async () => {
    const highImpact = await classify({highImpact: true});
    assert.equal(highImpact.route, 'main_agent');
    assert.equal(highImpact.reason, 'high_impact');
    const routine = await classify({impactProbability: 0.9});
    assert.equal(routine.route, 'group');
    assert.equal(routine.label, 'work');
    assert.equal(routine.abstained, false);
  });
}
