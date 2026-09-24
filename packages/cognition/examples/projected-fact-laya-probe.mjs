import {performance} from 'node:perf_hooks';
import {LayaDecisionModel, LocalLayaHttpTransport} from '../dist/laya-decision.js';
import {ProactiveDecisionService} from '../dist/proactive-decision.js';
import {decideProjectedFactImpact} from '../dist/projected-fact-decision.js';

// Manual local probe: supply an already running, authenticated loopback Laya service.
// The input is synthetic and represents the output shapes of the existing host ports.
const port = Number(process.env.LAYA_PORT);
const key = process.env.LAYA_API_KEY;
if (!Number.isSafeInteger(port) || !key) throw new Error('Local Laya configuration unavailable');
const decision = new ProactiveDecisionService(
  new LayaDecisionModel(new LocalLayaHttpTransport(port, () => key)));
const input = {
  graphNamespace: 'mvp-synthetic-meeting',
  projection: {graphRevision: 3, links: [{eventId: 'synthetic-change-2',
    fact: {id: 'meeting/time', revision: 2}, node: {id: 'memory-fact:meeting-time', revision: 2}}]},
  impact: {namespace: 'mvp-synthetic-meeting', graphRevision: 3,
    items: [{action: 'RECHECK', causes: [{reference: {id: 'memory-fact:meeting-time', revision: 1},
      currentRevision: 2}]}]},
  deadline: new Date(Date.now() + 30_000).toISOString(),
  signal: new AbortController().signal,
};
const started = performance.now();
const suggestions = await decideProjectedFactImpact(decision, input);
process.stdout.write(JSON.stringify({latencyMs: Math.round((performance.now() - started) * 10) / 10,
  suggestions}) + '\n');
