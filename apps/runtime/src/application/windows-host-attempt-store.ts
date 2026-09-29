import {ProtocolError} from '@personal-agent/contracts';
import {WINDOWS_HOST_TOOL_NAME} from '@personal-agent/contracts/windows-host';
import type {TaskRuntime} from '../index.js';
import type {WindowsHostAttemptStore, WindowsHostRunIdentity} from './windows-host-adapter.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET = /^[A-Za-z0-9_-]{16,128}$/;
const CHECKPOINT_PREFIX = 'windows-host-attempt:';

function valid(identity: WindowsHostRunIdentity): boolean {
  return identity !== null && typeof identity === 'object'
    && typeof identity.taskId === 'string' && RUN_ID.test(identity.taskId)
    && typeof identity.runId === 'string' && RUN_ID.test(identity.runId)
    && identity.toolName === WINDOWS_HOST_TOOL_NAME && identity.toolVersion === '1.0.0'
    && typeof identity.argumentsDigest === 'string' && SHA256.test(identity.argumentsDigest)
    && typeof identity.targetRef === 'string' && TARGET.test(identity.targetRef);
}

/** Reuses the Runtime task checkpoint transaction; no second journal or scheduler. */
export function createRuntimeWindowsHostAttemptStore(
  getRuntime: () => Pick<TaskRuntime, 'saveCheckpointOnce' | 'loadCheckpoint'>
): WindowsHostAttemptStore {
  if (typeof getRuntime !== 'function') {
    throw new ProtocolError('INVALID_ARGUMENT', 'Runtime attempt store requires a trusted Runtime getter');
  }
  return Object.freeze({
    record: async (identity: WindowsHostRunIdentity): Promise<void> => {
      if (!valid(identity)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid Windows Host run identity');
      const created = getRuntime().saveCheckpointOnce(identity.taskId,
        CHECKPOINT_PREFIX + identity.runId, identity);
      if (!created) throw new ProtocolError('REVISION_CONFLICT', 'Windows Host run identity already recorded');
    },
    read: async (taskId: string, runId: string): Promise<WindowsHostRunIdentity | undefined> => {
      if (!RUN_ID.test(taskId) || !RUN_ID.test(runId)) {
        throw new ProtocolError('INVALID_ARGUMENT', 'Invalid Windows Host task or run id');
      }
      const saved = getRuntime().loadCheckpoint(taskId, CHECKPOINT_PREFIX + runId);
      if (saved === undefined) return undefined;
      if (!valid(saved as WindowsHostRunIdentity)
        || (saved as WindowsHostRunIdentity).taskId !== taskId
        || (saved as WindowsHostRunIdentity).runId !== runId) {
        throw new ProtocolError('REVISION_CONFLICT', 'Windows Host saved run identity is invalid');
      }
      return saved as WindowsHostRunIdentity;
    },
  });
}
