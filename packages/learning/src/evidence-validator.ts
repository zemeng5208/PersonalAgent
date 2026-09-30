import {LearningError, type LearningContext, type WorkflowCandidate, type WorkflowValidatorPort} from './index.js';

export interface WorkflowEvidenceBinding {
  sourceRef: string;
  workflowId: string;
  revision: number;
  skillId: string;
  skillRevision: string;
  skillContentSha256: string;
  taskId: string;
  evidenceId: string;
  toolName: string;
  toolVersion: string;
  inputDigest: string;
}
export interface WorkflowEvidenceSkill {
  id: string; revision: string; contentSha256: string; enabled: boolean;
}
export interface WorkflowEvidenceCurrent {
  binding: WorkflowEvidenceBinding | null;
  skill: WorkflowEvidenceSkill | null;
}
export interface WorkflowEvidencePorts {
  /** Host-owned binding, not an agent's proposed proof. Null means deleted/withdrawn/unavailable. */
  readBinding(candidate: WorkflowCandidate, context: LearningContext): Promise<WorkflowEvidenceBinding | null>;
  readSkill(skillId: string, context: LearningContext): Promise<WorkflowEvidenceSkill | null>;
  /** Trusted coherent current source/Skill gate, under the host's original mutation fences.
   * Must read both authorities synchronously; never combine cached async snapshots or re-enable a source. */
  readCurrent(candidate: WorkflowCandidate, binding: WorkflowEvidenceBinding,
    context: LearningContext): WorkflowEvidenceCurrent | null;
  /** Adapt TaskRuntime.getTask/readToolExecutions; never use cloud self-reported success. */
  readExecution(taskId: string, evidenceId: string, context: LearningContext): Promise<{
    task: {taskId: string; state: string; evidenceRefs: readonly string[]};
    record: {taskId: string; evidenceId: string; toolName: string; toolVersion: string;
      inputDigest: string; policyDecision: string; executionStarted: boolean; state: string;
      finishedAt?: string};
  } | null>;
}

/** Validates a persisted Skill identity against one actual, policy-allowed Runtime execution. */
export function createEvidenceWorkflowValidator(ports: WorkflowEvidencePorts): WorkflowValidatorPort {
  const sha = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
  const check = (context: LearningContext): void => {
    if (context.signal.aborted) throw new LearningError('CANCELLED');
    if (!Number.isFinite(Date.parse(context.deadline))) throw new LearningError('INVALID_ARGUMENT');
    if (Date.parse(context.deadline) <= Date.now()) throw new LearningError('TIMEOUT');
  };
  return Object.freeze({async validate(candidate: WorkflowCandidate, context: LearningContext) {
    check(context);
    const bound = await ports.readBinding(structuredClone(candidate), context);
    check(context);
    if (!bound || bound.sourceRef !== candidate.sourceRef || bound.workflowId !== candidate.workflowId
      || bound.revision !== candidate.revision || !sha(bound.skillContentSha256) || !sha(bound.inputDigest)
      || !bound.evidenceId || !bound.skillId || !bound.skillRevision) throw new LearningError('NOT_VALIDATED');
    const binding = structuredClone(bound);
    const skill = await ports.readSkill(binding.skillId, context);
    check(context);
    const matchesSkill = (value: WorkflowEvidenceSkill | null): boolean => Boolean(value && value.enabled === true
      && value.id === binding.skillId && value.revision === binding.skillRevision
      && value.contentSha256 === binding.skillContentSha256);
    if (!matchesSkill(skill)) throw new LearningError('NOT_VALIDATED');
    const execution = await ports.readExecution(binding.taskId, binding.evidenceId, context);
    check(context);
    const record = execution?.record;
    if (!record
      || execution?.task.taskId !== binding.taskId || execution.task.state !== 'succeeded'
      || !execution.task.evidenceRefs.includes(binding.evidenceId)
      || record.taskId !== binding.taskId || record.evidenceId !== binding.evidenceId
      || record.toolName !== binding.toolName || record.toolVersion !== binding.toolVersion
      || record.inputDigest !== binding.inputDigest || record.policyDecision !== 'allow'
      || record.executionStarted !== true || record.state !== 'confirmed'
      || !record.finishedAt || !Number.isFinite(Date.parse(record.finishedAt))
      || Date.parse(record.finishedAt) > Date.now()) throw new LearningError('NOT_VALIDATED');
    const again = await ports.readBinding(structuredClone(candidate), context);
    check(context);
    if (JSON.stringify(again) !== JSON.stringify(binding)) throw new LearningError('REVISION_CONFLICT');
    // Execution/binding reads may wait. The original Skill snapshot cannot authorize a late pass.
    const currentSkill = await ports.readSkill(binding.skillId, context);
    check(context);
    if (!matchesSkill(currentSkill)) throw new LearningError('NOT_VALIDATED');
    // No await follows this joint gate. An async source/Skill read would reopen the opposite race.
    if (typeof ports.readCurrent !== 'function') throw new LearningError('NOT_VALIDATED');
    const current: unknown = ports.readCurrent(structuredClone(candidate), structuredClone(binding), context);
    check(context);
    if (current && typeof current === 'object' && 'then' in current && typeof current.then === 'function') {
      void Promise.resolve(current).catch(() => undefined);
      throw new LearningError('NOT_VALIDATED');
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new LearningError('NOT_VALIDATED');
    const joint = current as WorkflowEvidenceCurrent;
    if (JSON.stringify(joint.binding) !== JSON.stringify(binding)) throw new LearningError('REVISION_CONFLICT');
    if (!matchesSkill(joint.skill)) throw new LearningError('NOT_VALIDATED');
    return {passed: true, evidenceRef: binding.evidenceId};
  }});
}
