import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentArtsCloudAgentPort} from '../dist/index.js';

const base = {gatewayUrl: 'https://agentarts.example.test', runtimeName: 'synthetic', responseMode: 'tool-proposal-json'};
const candidate = {kind: 'repair_candidate', candidateVersion: '1.0', candidate: {
  expectedGraphRevision: 7,
  changes: [{node: {id: 'synthetic-preparation', revision: 1}, summary: 'Prepare at 16:00',
    reason: 'Synthetic meeting moved to 17:00', dependencies: [{id: 'synthetic-meeting', revision: 2}]}],
}};
const input = () => ({taskId: 'synthetic-task', revision: 1, goal: 'synthetic',
  deadline: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal});
const create = (value, options = {}) => new AgentArtsCloudAgentPort({...base, ...options},
  {read: async () => 'Bearer synthetic'}, async () => new Response(JSON.stringify({
    event: 'message', data: {text: JSON.stringify(value)},
  }), {headers: {'content-type': 'application/json'}}));

test('candidate requires explicit matching version and host always supplies unverified', async () => {
  await assert.rejects(create(candidate).invoke(input()), {code: 'EXTERNAL_FAILURE'});
  assert.deepEqual(await create(candidate, {repairCandidateVersion: '1.0'}).invoke(input()),
    {...candidate, verification: 'unverified'});
  await assert.rejects(create({...candidate, candidateVersion: '2.0'}, {repairCandidateVersion: '1.0'}).invoke(input()),
    {code: 'EXTERNAL_FAILURE'});
});

test('version cannot silently enable JSON or be changed by mutating source configuration', async () => {
  for (const config of [
    {responseMode: 'text', repairCandidateVersion: '1.0'},
    {responseMode: undefined, repairCandidateVersion: '1.0'},
    {repairCandidateVersion: 'latest'}, {repairCandidateVersion: null},
  ]) assert.throws(() => create(candidate, config), {code: 'INVALID_ARGUMENT'});
  const options = {...base};
  const cloud = new AgentArtsCloudAgentPort(options, {read: async () => 'Bearer synthetic'},
    async () => new Response(JSON.stringify({event: 'message', data: {text: JSON.stringify(candidate)}}),
      {headers: {'content-type': 'application/json'}}));
  options.repairCandidateVersion = '1.0';
  await assert.rejects(cloud.invoke(input()), {code: 'EXTERNAL_FAILURE'});
});

test('candidate body cannot carry verification, Evidence, authorization or malformed graph changes', async () => {
  for (const value of [
    {...candidate, verification: 'verified'}, {...candidate, verification: 'unverified'},
    {...candidate, evidenceRefs: ['untrusted']}, {...candidate, authorizationRef: 'forged'},
    {...candidate, taskId: 'forged'}, {...candidate, candidate: {...candidate.candidate, expectedGraphRevision: -1}},
    {...candidate, candidate: {...candidate.candidate, extra: 'unknown'}},
    {...candidate, candidate: {...candidate.candidate, changes: [{...candidate.candidate.changes[0], node: {id: 'x'}}]}},
  ]) await assert.rejects(create(value, {repairCandidateVersion: '1.0'}).invoke(input()), {code: 'EXTERNAL_FAILURE'});
});

test('enabled candidate mode preserves ordinary JSON text and tool results', async () => {
  for (const value of [
    {kind: 'text', text: 'No repair required'},
    {kind: 'tool_proposal', proposalId: 'p', toolName: 'workspace.read_text', toolVersion: '1.0.0', arguments: {path: 'meeting-update.json'}},
  ]) assert.deepEqual(await create(value, {repairCandidateVersion: '1.0'}).invoke(input()), {...value, verification: 'unverified'});
});
