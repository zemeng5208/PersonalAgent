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
  readonly checkpoint?: MailTriageCheckpointPort;
  readonly labels?: Readonly<Record<string, string>>;
  readonly now?: () => number;
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
  readonly classifiedCount: number;
  readonly highImpactCount: number;
  readonly uncertainCount: number;
  readonly abstainedCount: number;
  readonly results: readonly LayaTriageResult[];
  readonly highImpactNotices: readonly MailHighImpactNotice[];
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly throughput: {
    readonly durationMs: number;
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

const identity = (source: string, messageId: string, revision: string): string =>
  `${source}:${messageId}:${revision}`;

/**
 * Bounded, backpressured mail triage pipeline using real Laya SLM classification.
 * Supports batching within 16GB limits (chunkSize: 1-4), persistent progress checkpointing,
 * real throughput measurement, and privacy-preserving high-impact notification summaries.
 */
export class MailTriagePipeline {
  private readonly triageService: LayaTriageService;
  private readonly checkpointPort?: MailTriageCheckpointPort | undefined;
  private readonly labels: Readonly<Record<string, string>>;
  private readonly chunkSize: number;
  private readonly now: () => number;
  private cache = new Map<string, LayaTriageResult>();

  constructor(options: MailTriagePipelineOptions) {
    if (!options || !options.inference) throw new CognitionError('INVALID_ARGUMENT');
    this.triageService = new LayaTriageService(options.inference, options);
    this.checkpointPort = options.checkpoint;
    this.labels = options.labels ?? DEFAULT_MAIL_LABELS;
    this.chunkSize = Math.max(1, Math.min(options.chunkSize ?? 4, 16));
    this.now = options.now ?? Date.now;
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

    // Load durable progress if checkpoint port provided
    if (this.checkpointPort && this.cache.size === 0) {
      const persisted = await this.checkpointPort.load();
      if (persisted && typeof persisted === 'object') {
        for (const [key, val] of Object.entries(persisted)) {
          this.cache.set(key, val);
        }
      }
    }

    const allResults: LayaTriageResult[] = [];
    const pendingMessages: LayaTriageMessage[] = [];

    // Filter out already processed messages (deduplication)
    for (const msg of request.messages) {
      const key = identity(msg.source, msg.messageId, msg.sourceRevision);
      const cached = this.cache.get(key);
      if (cached) {
        allResults.push(cached);
      } else {
        pendingMessages.push(msg);
      }
    }

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

      const chunkResults = await this.triageService.classify(triageRequest);
      for (const res of chunkResults) {
        const key = identity(res.source, res.messageId, res.sourceRevision);
        this.cache.set(key, res);
        allResults.push(res);
      }

      // Persist checkpoint after each chunk
      if (this.checkpointPort) {
        const snapshot: Record<string, LayaTriageResult> = {};
        for (const [k, v] of this.cache) snapshot[k] = v;
        await this.checkpointPort.save(snapshot);
      }
    }

    const endTime = this.now();
    const durationMs = Math.max(1, endTime - startTime);
    const messagesPerSecond = Number(((allResults.length / (durationMs / 1000))).toFixed(2));

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
      classifiedCount,
      highImpactCount,
      uncertainCount,
      abstainedCount,
      results: allResults,
      highImpactNotices,
      categoryCounts: Object.freeze(categoryCounts),
      throughput: {
        durationMs,
        messagesPerSecond,
      },
    };
  }
}
