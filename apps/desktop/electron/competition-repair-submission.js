import {isDeepStrictEqual} from 'node:util';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';

const markerKey = 'mvp-repair-submitted';
const intentKey = 'local-repair-intent';
const conflict = () => { throw Error('Synthetic repair submission conflict'); };

/** Reattach a previously submitted local task after a crash before source marking. */
export function restoreSyntheticRepairSubmission(application, host, sourceTaskId,
  source, candidate, idempotencyKey) {
  const runtime = application.runtime;
  const prior = runtime.findTaskByIdempotencyKey('local-repair:' + idempotencyKey);
  if (!prior) return undefined;
  const intent = runtime.loadCheckpoint(prior.taskId, intentKey);
  if (!intent || intent.sourceTaskId !== sourceTaskId || intent.evidenceId !== source.evidenceId
    || intent.idempotencyKey !== idempotencyKey
    || typeof intent.deadline !== 'string' || !Number.isFinite(Date.parse(intent.deadline))
    || intent.graphNamespace !== host.localRepair.graphNamespace
    || intent.bindingVersion !== host.localRepair.bindingVersion
    || !isDeepStrictEqual(intent.sourceTool, host.localRepair.sourceTool)
    || !isDeepStrictEqual(intent.binding, source.binding)
    || !isDeepStrictEqual(intent.candidate, candidate)
    || !isDeepStrictEqual(prior.attachmentRefs,
      ['local-repair-intent:' + toolArgumentsDigest(intent)])) conflict();
  if (prior.state === 'created') {
    const resumed = application.submitLocalRepair({sourceTaskId, evidenceId: source.evidenceId,
      idempotencyKey, deadline: intent.deadline});
    if (resumed.taskId !== prior.taskId) conflict();
  }
  runtime.saveCheckpoint(sourceTaskId, markerKey, {taskId: prior.taskId});
  return runtime.getTask(prior.taskId);
}
