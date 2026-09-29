import {createHash} from 'node:crypto';
import {
  LayaTriageService,
  type LayaTriageMessage,
  type LayaTriageRequest,
  type LayaTriageResult,
  type LayaTriageOptions,
} from './laya-triage.js';
import type {LayaInferencePort} from './laya-decision.js';
import {CognitionError} from './impact.js';

export interface MailTriageCheckpointPort {
  load(): Record<string, LayaTriageResult> | Promise<Record<string, LayaTriageResult>>;
  save(results: Record<string, LayaTriageResult>): void | Promise<void>;
}

export interface MailTriagePipelineOptions extends LayaTriageOptions {
  readonly inference: LayaInferencePort;
  readonly checkpoint?: MailTriageCheckpointPort | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly now?: (() => number) | undefined;
}

export interface MailBatchTriageRequest {
  readonly messages: readonly LayaTriageMessage[];
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface MailHighImpactNotice {
  readonly messageId: string;
  readonly source: string;
  readonly sourceRevision: string;
  readonly label: string | null;
  readonly route: 'main_agent' | 'review';
  readonly reason: string;
  readonly confidence: number | null;
}

export interface MailBatchTriageSummary {
  readonly total: number;
  readonly cachedCount: number;
  readonly newlyClassifiedCount: number;
  readonly classifiedCount: number;
  readonly highImpactCount: number;
  readonly uncertainCount: number;
  readonly abstainedCount: number;
  readonly results: readonly LayaTriageResult[];
  readonly highImpactNotices: readonly MailHighImpactNotice[];
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly throughput: {
    readonly totalDurationMs: number;
    readonly inferenceDurationMs: number;
    readonly messagesPerSecond: number;
  };
}

export const DEFAULT_MAIL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  work: '工作邮件：涉及项目协作、任务分配、客户沟通与日常工作事务。',
  schedule: '日程与会议：包含会议邀请、改期通知、日程确认与时间安排。',
  finance: '财务与账单：发票凭据、报销单据、银行对账单及付款通知。',
  notification: '系统通知：自动化构建、告警邮件、服务变更及订阅推送。',
  promotional: '营销推广：活动推介、新闻资讯、产品宣传等低优先级邮件。',
});

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Bounded mail triage pipeline using real Laya SLM classification.
 * - Structured key binding source, messageId, revision, and label/model fingerprint
 * - Transactional checkpointing: cache is updated only AFTER durable save succeeds
 * - In-batch duplicate message deduplication
 * - Strictly separated model inference throughput calculation from cache hits
 * - High-impact notification summaries without text or header leakage
 */
export class MailTriagePipeline {
  private readonly triageService: LayaTriageService;
  private readonly checkpointPort?: MailTriageCheckpointPort | undefined;
  private readonly labels: Readonly<Record<string, string>>;
  private readonly chunkSize: number;
  private readonly now: () => number;
  private readonly configDigest: string;
  private cache = new Map<string, LayaTriageResult>();
  private checkpointLoaded = false;

  constructor(options: MailTriagePipelineOptions) {
    if (!options || !options.inference) throw new CognitionError('INVALID_ARGUMENT');
    this.triageService = new LayaTriageService(options.inference, options);
    this.checkpointPort = options.checkpoint;
    this.labels = options.labels ?? DEFAULT_MAIL_LABELS;
    this.chunkSize = Math.max(1, Math.min(options.chunkSize ?? 4, 16));
    this.now = options.now ?? Date.now;

    const sortedLabels = Object.entries(this.labels).sort(([a], [b]) => a.localeCompare(b));
    this.configDigest = hash(JSON.stringify({labels: sortedLabels, model: 'multilingual'}));
  }

  private makeKey(source: string, messageId: string, revision: string): string {
    return hash(JSON.stringify([source, messageId, revision, this.configDigest]));
  }

  /**
   * Processes a batch of projected mail messages with backpressure and bounded chunking.
   */
  async processBatch(request: MailBatchTriageRequest): Promise<MailBatchTriageSummary> {
    if (!request || !Array.isArray(request.messages) || !(request.signal instanceof AbortSignal)
      || !Number.isFinite(Date.parse(request.deadline))) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
    if (request.signal.aborted) throw new CognitionError('INVALID_ARGUMENT');
    if (this.now() >= Date.parse(request.deadline)) throw new CognitionError('INVALID_ARGUMENT');

    const startTime = this.now();

    // Load durable progress once if checkpoint port provided
    if (this.checkpointPort && !this.checkpointLoaded) {
      const persisted = await this.checkpointPort.load();
      if (persisted && typeof persisted === 'object') {
        for (const [key, val] of Object.entries(persisted)) {
          this.cache.set(key, val);
        }
      }
      this.checkpointLoaded = true;
    }

    // Deduplicate duplicate messages within the batch request itself
    const uniqueMessages: LayaTriageMessage[] = [];
    const seenBatch = new Set<string>();
    for (const msg of request.messages) {
      if (!msg || typeof msg.source !== 'string' || typeof msg.messageId !== 'string'
        || typeof msg.sourceRevision !== 'string' || typeof msg.text !== 'string') {
        throw new CognitionError('INVALID_ARGUMENT');
      }
      const rawIdentity = `${msg.source}:${msg.messageId}:${msg.sourceRevision}`;
      if (!seenBatch.has(rawIdentity)) {
        seenBatch.add(rawIdentity);
        uniqueMessages.push(msg);
      }
    }

    const allResults: LayaTriageResult[] = [];
    const pendingMessages: LayaTriageMessage[] = [];
    let cachedCount = 0;

    // Filter out already processed messages (deduplication from cache)
    for (const msg of uniqueMessages) {
      const key = this.makeKey(msg.source, msg.messageId, msg.sourceRevision);
      const cached = this.cache.get(key);
      if (cached) {
        allResults.push(cached);
        cachedCount++;
      } else {
        pendingMessages.push(msg);
      }
    }

    let cumulativeInferenceMs = 0;
    const newlyClassified: LayaTriageResult[] = [];

    // Process pending messages in bounded chunks
    for (let i = 0; i < pendingMessages.length; i += this.chunkSize) {
      if (request.signal.aborted) throw new CognitionError('INVALID_ARGUMENT');
      if (this.now() >= Date.parse(request.deadline)) throw new CognitionError('INVALID_ARGUMENT');

      const chunk = pendingMessages.slice(i, i + this.chunkSize);
      const triageRequest: LayaTriageRequest = {
        messages: chunk,
        labels: this.labels,
        deadline: request.deadline,
        signal: request.signal,
      };

      const inferenceStart = this.now();
      const chunkResults = await this.triageService.classify(triageRequest);
      const inferenceEnd = this.now();
      cumulativeInferenceMs += Math.max(1, inferenceEnd - inferenceStart);

      // Persist to checkpoint BEFORE committing to in-memory cache
      if (this.checkpointPort) {
        const snapshot: Record<string, LayaTriageResult> = {};
        for (const [k, v] of this.cache) snapshot[k] = v;
        for (const res of chunkResults) {
          snapshot[this.makeKey(res.source, res.messageId, res.sourceRevision)] = res;
        }
        // If save fails, this.cache is preserved without partial unpersisted entries
        await this.checkpointPort.save(snapshot);
      }

      // Safe to update cache now
      for (const res of chunkResults) {
        const key = this.makeKey(res.source, res.messageId, res.sourceRevision);
        this.cache.set(key, res);
        newlyClassified.push(res);
        allResults.push(res);
      }
    }

    const totalDurationMs = Math.max(1, this.now() - startTime);
    const newlyClassifiedCount = newlyClassified.length;

    // Pure model inference throughput: only newly classified messages divided by model inference time
    const messagesPerSecond = newlyClassifiedCount > 0
      ? Number(((newlyClassifiedCount / (cumulativeInferenceMs / 1000))).toFixed(2))
      : 0;

    // Compile summary and high impact notices
    let classifiedCount = 0;
    let highImpactCount = 0;
    let uncertainCount = 0;
    let abstainedCount = 0;
    const categoryCounts: Record<string, number> = {};
    const highImpactNotices: MailHighImpactNotice[] = [];

    for (const res of allResults) {
      if (res.abstained) {
        abstainedCount++;
      } else if (res.label) {
        classifiedCount++;
        categoryCounts[res.label] = (categoryCounts[res.label] ?? 0) + 1;
      }

      if (res.reason === 'uncertain') {
        uncertainCount++;
      }

      if (res.route === 'main_agent' || res.reason === 'high_impact') {
        highImpactCount++;
        highImpactNotices.push({
          messageId: res.messageId,
          source: res.source,
          sourceRevision: res.sourceRevision,
          label: res.label,
          route: res.route === 'group' ? 'main_agent' : res.route,
          reason: res.reason,
          confidence: res.scores?.answerConfidence ?? null,
        });
      }
    }

    return {
      total: allResults.length,
      cachedCount,
      newlyClassifiedCount,
      classifiedCount,
      highImpactCount,
      uncertainCount,
      abstainedCount,
      results: allResults,
      highImpactNotices,
      categoryCounts: Object.freeze(categoryCounts),
      throughput: {
        totalDurationMs,
        inferenceDurationMs: cumulativeInferenceMs,
        messagesPerSecond,
      },
    };
  }
}
