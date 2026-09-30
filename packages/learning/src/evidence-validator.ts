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
export interface WorkflowEvidencePorts {
  /** Host-owned binding, not an agent's proposed proof. Null means deleted/withdrawn/unavailable. */
  readBinding(candidate: WorkflowCandidate, context: LearningContext): Promise<WorkflowEvidenceBinding | null>;
  readSkill(skillId: string, context: LearningContext): Promise<{
    id: string; revision: string; contentSha256: string; enabled: boolean;
  } | null>;
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
    const execution = await ports.readExecution(binding.taskId, binding.evidenceId, context);
    check(context);
    const record = execution?.record;
    if (!skill || !skill.enabled || skill.id !== binding.skillId || skill.revision !== binding.skillRevision
      || skill.contentSha256 !== binding.skillContentSha256 || !record
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
    return {passed: true, evidenceRef: binding.evidenceId};
  }});
}
