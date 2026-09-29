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
