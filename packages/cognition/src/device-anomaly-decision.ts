import {createHash} from 'node:crypto';
import {
  LayaActionChoiceService,
  actionArgumentsDigest,
  type LayaActionCandidate,
  type LayaActionSelection,
} from './laya-action-choice.js';
import type {LayaInferencePort} from './laya-decision.js';
import {CognitionError} from './impact.js';

export interface DeviceSample {
  readonly source: string;
  readonly timestamp: string;
  readonly cpuPercent: number;
  readonly memoryPercent: number;
  readonly diskPercent?: number;
  readonly samplingIntervalMs: number;
  readonly unavailableMetrics?: readonly string[];
}

export interface DeviceAnomalyOptions {
  /** Alert trigger threshold for CPU percentage (default: 90). */
  readonly cpuThresholdPercent?: number | undefined;
  /** Alert trigger threshold for Memory percentage (default: 90). */
  readonly memoryThresholdPercent?: number | undefined;
  /** Hysteresis recovery threshold below which anomaly clears (default: 80). */
  readonly recoveryThresholdPercent?: number | undefined;
  /** Consecutive samples required to confirm an anomaly (default: 3). */
  readonly sustainedSampleCount?: number | undefined;
  /** Minimum interval in milliseconds between repeated alert notifications (default: 300,000 = 5 min). */
  readonly cooldownMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export type DeviceAnomalyStatus =
  | 'normal'
  | 'monitoring'
  | 'alert_triggered'
  | 'alert_active_hysteresis'
  | 'cooldown_suppressed'
  | 'recovered'
  | 'replayed';

export interface DeviceAnomalyDecisionReceipt {
  readonly receiptId: string;
  readonly status: DeviceAnomalyStatus;
  readonly isAlertActive: boolean;
  readonly consecutiveElevatedCount: number;
  readonly sample: DeviceSample;
  readonly selection?: LayaActionSelection | undefined;
  readonly selectedCandidate?: LayaActionCandidate | undefined;
  readonly candidates?: readonly LayaActionCandidate[] | undefined;
  readonly safeAdvice: string;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Proactive decision service for system device anomaly evaluation.
 * Consumes telemetry projections, applies continuous sampling confirmation (3 samples),
 * hysteresis (recovery < 80%), notification deduplication (cooldown), and delegates
 * intervention selection to real Laya SLM across safe, reversible actions only.
 * STRICT GUARDRAIL: Never kills processes, shuts down applications, deletes files, or alters security settings.
 */
export class DeviceAnomalyDecisionService {
  private readonly choiceService: LayaActionChoiceService;
  private readonly cpuThreshold: number;
  private readonly memoryThreshold: number;
  private readonly recoveryThreshold: number;
  private readonly sustainedCount: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private consecutiveElevatedCount = 0;
  private isAlertActive = false;
  private lastAlertTimestampMs: number | null = null;
  private lastProcessedTimestampMs: number | null = null;
  private sampleRevisionCounter = 0;

  constructor(
    inference: LayaInferencePort,
    options: DeviceAnomalyOptions = {}
  ) {
    if (!inference) throw new CognitionError('INVALID_ARGUMENT');
    this.choiceService = new LayaActionChoiceService(inference);
    this.cpuThreshold = options.cpuThresholdPercent ?? 90;
    this.memoryThreshold = options.memoryThresholdPercent ?? 90;
    this.recoveryThreshold = options.recoveryThresholdPercent ?? 80;
    this.sustainedCount = Math.max(1, options.sustainedSampleCount ?? 3);
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.now = options.now ?? Date.now;

    if (this.recoveryThreshold >= this.cpuThreshold || this.recoveryThreshold >= this.memoryThreshold) {
      throw new CognitionError('INVALID_ARGUMENT');
    }
  }

  /**
   * Evaluates an incoming device status sample against thresholds, hysteresis, and Laya action choice.
   */
  async evaluateSample(
    sample: DeviceSample,
    layaRequest?: {deadline: string; signal: AbortSignal}
  ): Promise<DeviceAnomalyDecisionReceipt> {
    if (!sample || typeof sample.source !== 'string' || !sample.source.trim()
      || !Number.isFinite(Date.parse(sample.timestamp))
      || typeof sample.cpuPercent !== 'number' || sample.cpuPercent < 0 || sample.cpuPercent > 100
      || typeof sample.memoryPercent !== 'number' || sample.memoryPercent < 0 || sample.memoryPercent > 100
      || !Number.isSafeInteger(sample.samplingIntervalMs) || sample.samplingIntervalMs <= 0) {
      throw new CognitionError('INVALID_ARGUMENT');
    }

    const sampleTimeMs = Date.parse(sample.timestamp);

    // Replay / Monotonicity check
    if (this.lastProcessedTimestampMs !== null && sampleTimeMs <= this.lastProcessedTimestampMs) {
      return {
        receiptId: hash(`replay:${sample.source}:${sample.timestamp}`),
        status: 'replayed',
        isAlertActive: this.isAlertActive,
        consecutiveElevatedCount: this.consecutiveElevatedCount,
        sample,
        safeAdvice: '忽略重放或非递增时间戳的旧采样数据',
      };
    }
    this.lastProcessedTimestampMs = sampleTimeMs;
    this.sampleRevisionCounter++;

    const isCpuUnavailable = sample.unavailableMetrics?.includes('cpu');
    const isMemoryUnavailable = sample.unavailableMetrics?.includes('memory');

    const cpuExceeded = !isCpuUnavailable && sample.cpuPercent >= this.cpuThreshold;
    const memoryExceeded = !isMemoryUnavailable && sample.memoryPercent >= this.memoryThreshold;
    const isElevated = cpuExceeded || memoryExceeded;

    if (isElevated) {
      this.consecutiveElevatedCount++;

      // Check if elevated condition is sustained across samples
      if (this.consecutiveElevatedCount >= this.sustainedCount) {
        // Sustained anomaly confirmed: check cooldown suppression
        if (this.isAlertActive && this.lastAlertTimestampMs !== null
          && (sampleTimeMs - this.lastAlertTimestampMs < this.cooldownMs)) {
          return {
            receiptId: hash(`cooldown:${sample.source}:${sample.timestamp}:${this.sampleRevisionCounter}`),
            status: 'cooldown_suppressed',
            isAlertActive: true,
            consecutiveElevatedCount: this.consecutiveElevatedCount,
            sample,
            safeAdvice: `系统资源持续高负荷（CPU: ${sample.cpuPercent}%, 内存: ${sample.memoryPercent}%），已在冷却窗口（${Math.round(this.cooldownMs / 1000)}s）内抑制重复通知。`,
          };
        }

        // Trigger alert and generate safe candidates for Laya choice
        this.isAlertActive = true;
        this.lastAlertTimestampMs = sampleTimeMs;

        const expiresAt = new Date(this.now() + 120_000).toISOString();
        const candidates = this.buildSafeCandidates(sample, expiresAt);

        const context = `[设备性能状态] 来源: ${sample.source}, 时间: ${sample.timestamp}, CPU使用率: ${sample.cpuPercent}%, 内存使用率: ${sample.memoryPercent}%, 采样间隔: ${sample.samplingIntervalMs}ms. 连续超标采样次数: ${this.consecutiveElevatedCount}.`;

        const deadline = layaRequest?.deadline ?? new Date(this.now() + 60_000).toISOString();
        const signal = layaRequest?.signal ?? new AbortController().signal;

        const selection = await this.choiceService.choose({
          context,
          candidates,
          deadline,
          signal,
        });

        const selectedCandidate = candidates.find(c => c.id === selection.selected?.id);
        const safeAdvice = this.formatAdvice(selectedCandidate, selection);

        return {
          receiptId: hash(`alert:${sample.source}:${sample.timestamp}:${this.sampleRevisionCounter}`),
          status: 'alert_triggered',
          isAlertActive: true,
          consecutiveElevatedCount: this.consecutiveElevatedCount,
          sample,
          selection,
          selectedCandidate,
          candidates,
          safeAdvice,
        };
      }

      // Elevated but still accumulating samples for confirmation
      return {
        receiptId: hash(`monitoring:${sample.source}:${sample.timestamp}:${this.sampleRevisionCounter}`),
        status: 'monitoring',
        isAlertActive: this.isAlertActive,
        consecutiveElevatedCount: this.consecutiveElevatedCount,
        sample,
        safeAdvice: `检测到系统指标超过阈值（CPU: ${sample.cpuPercent}%, 内存: ${sample.memoryPercent}%），当前连续采样 ${this.consecutiveElevatedCount}/${this.sustainedCount} 次，持续观察中。`,
      };
    }

    // Not elevated: check hysteresis recovery
    const cpuRecovered = isCpuUnavailable || sample.cpuPercent < this.recoveryThreshold;
    const memoryRecovered = isMemoryUnavailable || sample.memoryPercent < this.recoveryThreshold;

    if (cpuRecovered && memoryRecovered) {
      const wasActive = this.isAlertActive;
      this.isAlertActive = false;
      this.consecutiveElevatedCount = 0;

      if (wasActive) {
        return {
          receiptId: hash(`recovered:${sample.source}:${sample.timestamp}:${this.sampleRevisionCounter}`),
          status: 'recovered',
          isAlertActive: false,
          consecutiveElevatedCount: 0,
          sample,
          safeAdvice: `系统资源负载已恢复至安全阈值以下（CPU: ${sample.cpuPercent}%, 内存: ${sample.memoryPercent}% < ${this.recoveryThreshold}%），异常状态已解除。`,
        };
      }

      return {
        receiptId: hash(`normal:${sample.source}:${sample.timestamp}:${this.sampleRevisionCounter}`),
        status: 'normal',
        isAlertActive: false,
        consecutiveElevatedCount: 0,
        sample,
        safeAdvice: `系统资源运行正常（CPU: ${sample.cpuPercent}%, 内存: ${sample.memoryPercent}%）。`,
      };
    }

    // Inside hysteresis band (between recovery threshold and alarm threshold)
    return {
      receiptId: hash(`hysteresis:${sample.source}:${sample.timestamp}:${this.sampleRevisionCounter}`),
      status: this.isAlertActive ? 'alert_active_hysteresis' : 'normal',
      isAlertActive: this.isAlertActive,
      consecutiveElevatedCount: this.consecutiveElevatedCount,
      sample,
      safeAdvice: `系统指标处于迟滞恢复观察带（CPU: ${sample.cpuPercent}%, 内存: ${sample.memoryPercent}%），保持现有${this.isAlertActive ? '告警' : '常规'}状态。`,
    };
  }

  /**
   * Constructs exactly 3 safe, reversible candidate options.
   * Explicitly avoids any destructive operations.
   */
  private buildSafeCandidates(sample: DeviceSample, expiresAt: string): readonly LayaActionCandidate[] {
    const sourceRef = {id: sample.source, revision: this.sampleRevisionCounter};

    // Candidate 1: Remind user to inspect via desktop notification (pre-authorized low-risk tool)
    const notifyTool = {
      name: 'desktop:notify',
      version: '1.0.0',
      arguments: Object.freeze({
        level: 'warning',
        title: '系统资源告警',
        message: `CPU使用率达到 ${sample.cpuPercent}%，内存使用率达到 ${sample.memoryPercent}%。建议检查高占用任务。`,
      }),
    };
    const notifyDigest = actionArgumentsDigest(notifyTool.arguments);
    const notifyScope = 'desktop:notify';

    const candidate1: LayaActionCandidate = {
      id: 'remind_user_inspect',
      revision: 1,
      kind: 'tool',
      description: '通过桌面通知向用户发出资源告警，建议手动检查或排查耗电/高占用应用',
      sources: [sourceRef],
      scopeRef: notifyScope,
      expiresAt,
      risk: 'low',
      tool: notifyTool,
      argumentsDigest: notifyDigest,
      authorization: {
        state: 'granted',
        refDigest: hash(`${notifyScope}:${notifyDigest}:${expiresAt}`),
        scopeRef: notifyScope,
        argumentsDigest: notifyDigest,
        expiresAt,
      },
    };

    // Candidate 2: Defer background syncing / indexing tasks (reversible non-tool defer)
    const candidate2: LayaActionCandidate = {
      id: 'defer_background_tasks',
      revision: 1,
      kind: 'defer',
      description: '暂缓非紧急的后台同步、本地索引与定期任务，降低背景争抢',
      sources: [sourceRef],
      scopeRef: 'agent:background_scheduler',
      expiresAt,
      risk: 'low',
      argumentsDigest: actionArgumentsDigest({}),
    };

    // Candidate 3: Escalate to diagnostic review without mutating system (escalate)
    const candidate3: LayaActionCandidate = {
      id: 'escalate_diagnostics',
      revision: 1,
      kind: 'escalate',
      description: '记录瞬时性能指标快照并呈报用户审查，保持系统配置与进程不变',
      sources: [sourceRef],
      scopeRef: 'diagnostics:review',
      expiresAt,
      risk: 'low',
      argumentsDigest: actionArgumentsDigest({}),
    };

    return Object.freeze([candidate1, candidate2, candidate3]);
  }

  private formatAdvice(
    candidate: LayaActionCandidate | undefined,
    selection: LayaActionSelection
  ): string {
    if (!candidate || selection.state !== 'selected') {
      return 'Laya 建议保持当前状态并由用户人工核实（不执行自动化系统操作）。';
    }
    switch (candidate.id) {
      case 'remind_user_inspect':
        return 'Laya 决定通过桌面通知提醒用户检查资源占用情况；所有操作为纯建议与轻量通知，未中止任何应用或进程。';
      case 'defer_background_tasks':
        return 'Laya 决定暂缓非关键后台同步以降低资源开销；该动作完全可逆，待系统负荷下降后自动恢复。';
      case 'escalate_diagnostics':
        return 'Laya 决定记录诊断指标快照并请求用户确认，不对操作系统运行环境做任何非授权修改。';
      default:
        return `Laya 建议执行可逆安全操作: ${candidate.description}`;
    }
  }
}
