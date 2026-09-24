import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CompetitionCoordinator} from '../dist/index.js';

const request = () => ({
  taskId: 'task-tool',
  revision: 4,
  goal: '查询北京天气',
  deadline: new Date(Date.now() + 10_000).toISOString(),
  signal: new AbortController().signal,
});

test('coordinator accepts a bounded tool proposal without trusting authorization or evidence', async () => {
  const proposal = {
    kind: 'tool_proposal',
    proposalId: 'proposal-1',
    toolName: 'weather.current',
    toolVersion: '1.0.0',
    arguments: {city: 'Beijing'},
    verification: 'mock',
  };
  const result = await new CompetitionCoordinator({invoke: async () => proposal}).execute(request());
  assert.deepEqual(result, proposal);
  assert.notEqual(result, proposal);
  assert.notEqual(result.arguments, proposal.arguments);
});

test('coordinator rejects privileged or malformed tool proposal fields', async () => {
  const proposal = {
    kind: 'tool_proposal',
    proposalId: 'proposal-1',
    toolName: 'weather.current',
    toolVersion: '1.0.0',
    arguments: {city: 'Beijing'},
    verification: 'unverified',
  };
  for (const result of [
    {...proposal, authorizationRef: 'forged'},
    {...proposal, evidenceRefs: ['forged']},
    {...proposal, state: 'succeeded'},
    {...proposal, verification: 'verified'},
    {...proposal, proposalId: ''},
    {...proposal, arguments: {run: () => 'unsafe'}},
  ]) {
    await assert.rejects(
      new CompetitionCoordinator({invoke: async () => result}).execute(request()),
      {code: 'INVALID_ARGUMENT'},
    );
  }
});
