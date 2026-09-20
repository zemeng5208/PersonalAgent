import { ProtocolError } from '@personal-agent/contracts';
import type { RegisteredTool, StoragePort, ToolDescriptor, ToolHost } from '@personal-agent/contracts';
import { NotificationService } from './service.js';
import type { DrainReport, StatusReport } from './service.js';
import { assertPolicyValid } from './policy.js';
import type { NotificationPolicy } from './policy.js';

export { NotificationService } from './service.js';
export type { DrainReport, NotificationBatch, NotificationServiceOptions, PendingItem, StatusReport } from './service.js';
export { assertPolicyValid, localMinuteOfDay, nextQuietEndMs, quietHoursActive } from './policy.js';
export type { DigestPolicy, NotificationPolicy, QuietHours } from './policy.js';

export const NOTIFICATIONS_MODULE_VERSION = '0.1.0-alpha.1';

const UTC_PATTERN_STRING = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';

const statusOutputSchema: ToolDescriptor['outputSchema'] = {
  type: 'object',
  required: ['pausedUntil', 'quietUntil', 'pending', 'nextDigestCloseAt', 'unacknowledgedBatches', 'policy'],
  additionalProperties: false,
  properties: {
    pausedUntil: {type: ['string', 'null'], pattern: UTC_PATTERN_STRING},
    quietUntil: {type: ['string', 'null'], pattern: UTC_PATTERN_STRING},
    pending: {type: 'integer', minimum: 0},
    nextDigestCloseAt: {type: ['string', 'null'], pattern: UTC_PATTERN_STRING},
    unacknowledgedBatches: {type: 'integer', minimum: 0, description: '已裁定但桌面尚未确认接收的批次数；崩溃重启后这些批次会被 drain 原样返回。'},
    policy: {
      type: 'object',
      required: ['quietHoursConfigured', 'pauseConfigured', 'digestConfigured'],
      additionalProperties: false,
      properties: {
        quietHoursConfigured: {type: 'boolean'},
        pauseConfigured: {type: 'boolean'},
        digestConfigured: {type: 'boolean'},
        quietStartLocal: {type: 'string'},
        quietEndLocal: {type: 'string'},
        quietTimeZone: {type: 'string'},
        digestWindowMs: {type: 'integer', minimum: 60000},
        digestMaxItems: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
};

export interface NotificationsModuleOptions {
  storage: StoragePort;
  policy: NotificationPolicy;
  now?: () => number;
  idFactory?: () => string;
}

/**
 * 注册只读状态工具 `notifications.status`。裁定由宿主在 Runtime 调度点调用
 * `service.drain()`（调度建议见 `service.planSchedules`）；展示归 `zemeng` 的桌面端。
 * 策略是装配期注入的用户规则，本包不提供运行期改写工具。
 */
export function register(host: ToolHost, options: NotificationsModuleOptions): () => void {
  if (!options?.storage) throw new ProtocolError('INVALID_ARGUMENT', 'Notification storage must be explicitly provided');
  if (!options?.policy) throw new ProtocolError('INVALID_ARGUMENT', 'Notification policy must be explicitly provided');
  assertPolicyValid(options.policy);
  let counter = 0;
  const service = new NotificationService(options.storage, options.policy, {
    now: options.now ?? Date.now,
    idFactory: options.idFactory ?? (() => `notif_${Date.now().toString(36)}_${(++counter).toString(36)}`),
  });

  const tool: RegisteredTool = {
    descriptor: {
      name: 'notifications.status',
      version: NOTIFICATIONS_MODULE_VERSION,
      inputSchema: {
        type: 'object',
        description: '查询通知策略的当前状态：暂停/安静时段是否生效、待裁定条数、下一个聚合窗口关闭时刻。只读，不触发裁定。',
        additionalProperties: false,
        properties: {},
      },
      outputSchema: statusOutputSchema,
      sideEffect: 'read',
      requiredScopes: ['notifications:read'],
      idempotencySupport: true,
      recoverySupport: true,
      requiresPresence: false,
    },
    execute: async (): Promise<StatusReport & {policy: Record<string, unknown>}> => {
      const status = service.status();
      const policy: Record<string, unknown> = {
        quietHoursConfigured: options.policy.quietHours !== undefined,
        pauseConfigured: options.policy.pauseUntilUtc !== undefined,
        digestConfigured: options.policy.digest !== undefined,
      };
      if (options.policy.quietHours !== undefined) {
        policy.quietStartLocal = options.policy.quietHours.startLocal;
        policy.quietEndLocal = options.policy.quietHours.endLocal;
        policy.quietTimeZone = options.policy.quietHours.timeZone;
      }
      if (options.policy.digest !== undefined) {
        policy.digestWindowMs = options.policy.digest.windowMs;
        policy.digestMaxItems = options.policy.digest.maxItems;
      }
      return {...status, policy};
    },
  };

  return host.register(tool);
}
