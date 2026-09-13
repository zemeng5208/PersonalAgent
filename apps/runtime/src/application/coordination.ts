import {ProtocolError} from '@personal-agent/contracts';
import type {TaskSnapshot} from '@personal-agent/contracts';
import {parseCoordinationTextResult, type CoordinationPort} from '@personal-agent/coordination';
import type {TaskRuntime} from '../index.js';

/** Text-only competition slice. Runtime, not the adapter, commits task state. */
export function startCoordinationTask(runtime: TaskRuntime, port: CoordinationPort | undefined, taskId: string, goal: string, deadline: string): Promise<TaskSnapshot> {
  return runtime.runTask(taskId, async context => {
    if (!port) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'Competition coordination is unavailable');
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ProtocolError('CANCELLED', 'Coordination request cancelled'));
      context.signal.addEventListener('abort', onAbort, {once: true});
      if (context.signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'Coordination request cancelled');
          return port.execute(Object.freeze({taskId, goal, revision: runtime.getTask(taskId).revision,
            deadline: context.deadline, signal: context.signal}));
        }).catch(() => {
          // Adapter errors may contain credentials or private response bodies.
          throw new ProtocolError('EXTERNAL_FAILURE', 'Coordination adapter failed');
        }),
        cancelled,
      ]);
      const text = parseCoordinationTextResult(result);
      return {resultSummary: `${text.text}\n[profile=huawei_ict_agentarts; verification=${text.verification}]`};
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }, {deadline, sideEffect: 'read'});
}
