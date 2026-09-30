// Explicit local-model acceptance. No mailbox credentials, network source or cloud.
import {mkdirSync, existsSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLocalLayaHost} from '../../../apps/desktop/electron/laya-local-host.js';
import {LocalLayaBatchHttpTransport, LocalLayaHttpTransport, LayaTriageService,
  LayaActionChoiceService, MailTriagePipeline, DEFAULT_MAIL_LABELS,
  DeviceAnomalyDecisionService} from '@personal-agent/cognition';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.cache/p5-real-laya');
mkdirSync(output, {recursive: true});
const checkpoint = name => {
  const file = path.join(output, name);
  return {load: () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined,
    save: value => {writeFileSync(`${file}.tmp`, JSON.stringify(value)); renameSync(`${file}.tmp`, file);}};
};
const host = createLocalLayaHost({projectRoot: root,
  createService: ({port, getApiKey}) => new LayaTriageService(new LocalLayaBatchHttpTransport(port, getApiKey),
    {batching: 'multi_state', labels: DEFAULT_MAIL_LABELS, minimumAnswerProbability: 0.70, minimumMargin: 0.15}),
  createChooser: ({port, getApiKey}) => new LayaActionChoiceService(new LocalLayaHttpTransport(port, getApiKey)),
  onUpdate: () => console.log(JSON.stringify({laya: host.snapshot()}))});
const summary = value => ({total: value.total, cachedCount: value.cachedCount,
  newlyClassifiedCount: value.newlyClassifiedCount, classifiedCount: value.classifiedCount,
  uncertainCount: value.uncertainCount, needsReviewCount: value.needsReviewCount,
  highImpactCount: value.highImpactCount, throughput: value.throughput,
  reasons: value.results.reduce((counts, result) => ({...counts, [result.reason]: (counts[result.reason] ?? 0) + 1}), {})});
const templates = [
  '会议邀请：项目计划评审于周三14点开始，请确认参会。',
  'Code review request: please review the authentication unit tests before Friday.',
  '科技周刊订阅：本周开源工具和技术新闻摘要。',
  'Invoice receipt: your order has been paid. Payment confirmation attached.',
  '家人来信：周末一起吃饭，最近天气不错。',
  'Hello, this message has no specific topic or requested action.',
];
const run = String(Date.now());
const messages = Array.from({length: 24}, (_, index) => ({source: 'synthetic:mail-acceptance',
  messageId: `${run}-${index}`, sourceRevision: '1', text: templates[index % templates.length]}));
const report = {startedAt: new Date().toISOString(), source: 'synthetic_projected_headers',
  model: 'local_multilingual', modelConnected: false, thresholds: {probability: 0.70, margin: 0.15}};
const context = () => ({deadline: new Date(Date.now() + 180_000).toISOString(), signal: new AbortController().signal});
try {
  report.start = await host.start();
  if (!report.start.ready) throw Error('Existing local model did not become ready');
  report.modelConnected = true;
  const counted = {calls: 0, classify: async input => {counted.calls++; return host.classify(input);}};
  const durable = checkpoint(`mail-${run}.json`);
  const pipeline = new MailTriagePipeline({classifier: counted, checkpoint: {
    load: () => durable.load() ?? {}, save: durable.save}});
  report.batch = summary(await pipeline.processBatch({messages, ...context()}));
  report.batch.modelCalls = counted.calls;
  console.log(JSON.stringify({batch: report.batch}));
  const beforeCache = counted.calls;
  report.cache = summary(await pipeline.processBatch({messages, ...context()}));
  report.cache.modelCalls = counted.calls - beforeCache;
  const restarted = new MailTriagePipeline({classifier: counted, checkpoint: {
    load: () => durable.load() ?? {}, save: durable.save}});
  const beforeRestart = counted.calls;
  report.restart = summary(await restarted.processBatch({messages, ...context()}));
  report.restart.modelCalls = counted.calls - beforeRestart;
  const blankCalls = counted.calls;
  report.blank = summary(await new MailTriagePipeline({inference: {infer: async () => {
    counted.calls++; throw Error('Blank must not call model');}}}).processBatch({
    messages: [{source: 'synthetic:blank', messageId: run, sourceRevision: '1', text: '  '}], ...context()}));
  report.blank.modelCalls = counted.calls - blankCalls;
  const cancelled = new AbortController();
  const partialMessages = messages.map(value => ({...value, messageId: `partial-${value.messageId}`}));
  const partialStore = checkpoint(`partial-${run}.json`);
  const partialPipeline = () => new MailTriagePipeline({classifier: counted, checkpoint: {
    load: () => partialStore.load() ?? {}, save: partialStore.save}});
  const page = {messages: partialMessages.slice(0, 8), hasMore: false, nextCursor: {uidValidity: 1, lastUid: 8}};
  report.partial = summary(await partialPipeline().processPagedStream({fetchPage: async () => page,
    ...context(), signal: cancelled.signal, onProgress: value => {if (value.processedCount === 4) cancelled.abort();}}));
  const beforeResume = counted.calls;
  const resumed = await partialPipeline().processPagedStream({fetchPage: async () => page, ...context()});
  report.resume = {...summary(resumed), lastCursor: resumed.lastCursor, stoppedReason: resumed.stoppedReason,
    modelCalls: counted.calls - beforeResume};
  const device = new DeviceAnomalyDecisionService({choose: input => host.choose(input)},
    {checkpoint: checkpoint(`device-${run}.json`), sustainedSampleCount: 3});
  const base = Date.now();
  for (let i = 0; i < 3; i++) {
    report.device = await device.evaluateSample({source: 'synthetic:elevated-metrics',
      timestamp: new Date(base + i * 1000).toISOString(), cpuPercent: 96, memoryPercent: 94,
      samplingIntervalMs: 1000}, context());
  }
  report.deviceRestart = await new DeviceAnomalyDecisionService({choose: input => host.choose(input)},
    {checkpoint: checkpoint(`device-${run}.json`), sustainedSampleCount: 3}).readFeedback();
} catch (error) {
  report.failure = String(error.message);
  process.exitCode = 1;
} finally {
  report.stop = await host.stop();
  report.completedAt = new Date().toISOString();
  writeFileSync(path.join(output, `report-${run}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
