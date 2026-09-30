import {createHash} from 'node:crypto';

/** Historical ownership uses the original persisted intent, never current MCP connectivity. */
export function ownsDesktopReferenceSkillTask(application, subjectRef, task) {
  try {
    if (!boundedId(subjectRef) || task.conversationId !== `desktop-skills:${subjectRef}`
      || task.goal !== 'Summarize an approved workspace reference') return false;
    const intent = application.runtime.loadCheckpoint(task.taskId, 'application-reference-skill-v1');
    const binding = application.runtime.loadCheckpoint(task.taskId, 'desktop-reference-binding-v1');
    if (!intent || intent.conversationId !== task.conversationId || intent.hostBinding !== undefined
      || !Number.isFinite(Date.parse(intent.deadline)) || typeof binding !== 'string'
      || !/^[a-f0-9]{64}$/.test(binding) || !intent.input
      || intent.input.skillId !== 'workspace-reference-summary' || intent.input.version !== '1.0.0'
      || typeof intent.input.path !== 'string' || !intent.input.path.trim()
      || intent.input.path.length > 1024 || intent.input.path.includes('\0')
      || !/^[a-f0-9]{64}$/.test(intent.input.digest)) return false;
    const attachment = 'reference-skill-intent:' + createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    return task.attachmentRefs?.includes(attachment) === true;
  } catch { return false; }
}

function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function payloadWithKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw Error('Evidence request is invalid');
  }
  return value;
}

/** Host-only bridge. The renderer can name a task but cannot assign its identity or permissions. */
export function createDesktopEvidenceHost({application, subjectRef, ownsTask, isAdminSession}) {
  if (!boundedId(subjectRef) || typeof ownsTask !== 'function' || typeof isAdminSession !== 'function') {
    throw Error('Trusted Evidence session is unavailable');
  }
  function scopeFor(taskId) {
    if (!boundedId(taskId) || !isAdminSession()) throw Error('Evidence access denied');
    try {
      const task = application.runtime.getTask(taskId);
      if (!boundedId(task.conversationId) || ownsTask(task) !== true) throw Error();
      return Object.freeze({subjectRef, conversationId: task.conversationId, taskId});
    } catch { throw Error('Evidence access denied'); }
  }
  function authorize(scope) {
    try {
      const current = scopeFor(scope.taskId);
      return current.subjectRef === scope.subjectRef && current.conversationId === scope.conversationId;
    } catch { return false; }
  }
  function reader(taskId) {
    if (typeof application?.createEvidenceReader !== 'function') throw Error('Evidence metadata is unavailable');
    return application.createEvidenceReader({...scopeFor(taskId), authorize});
  }
  return {
    list(input) {
      const request = payloadWithKeys(input, ['taskId'], ['limit', 'beforeEvidenceId']);
      if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50)
        || request.beforeEvidenceId !== undefined && !boundedId(request.beforeEvidenceId)) {
        throw Error('Evidence request is invalid');
      }
      return reader(request.taskId).list({...(request.limit === undefined ? {} : {limit: request.limit}),
        ...(request.beforeEvidenceId === undefined ? {} : {beforeEvidenceId: request.beforeEvidenceId})});
    },
    get(input) {
      const request = payloadWithKeys(input, ['taskId', 'evidenceId']);
      if (!boundedId(request.evidenceId)) throw Error('Evidence request is invalid');
      return reader(request.taskId).get(request.evidenceId);
    },
    async revoke(input) {
      const request = payloadWithKeys(input, ['taskId', 'authorizationRef', 'expectedApprovalRevision']);
      if (!boundedId(request.authorizationRef) || !Number.isSafeInteger(request.expectedApprovalRevision)
        || request.expectedApprovalRevision < 1 || typeof application?.revokeHostAuthorization !== 'function') {
        throw Error('Authorization revocation is unavailable');
      }
      const scope = scopeFor(request.taskId);
      const result = await application.revokeHostAuthorization({...scope,
        authorizationRef: request.authorizationRef,
        expectedApprovalRevision: request.expectedApprovalRevision,
        authorize: current => current.authorizationRef === request.authorizationRef && authorize(current)});
      if (result?.grantPresent !== false) throw Error('Authorization revocation readback failed');
      return result;
    },
  };
}
