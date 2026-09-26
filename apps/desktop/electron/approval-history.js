/** The Desktop bridge reads one bounded public approval page at a time. */
export async function readApprovalPage(client, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (Object.getPrototypeOf(payload) !== Object.prototype
      && Object.getPrototypeOf(payload) !== null)
    || Object.keys(payload).some(key => key !== 'beforeRowId')
    || (payload.beforeRowId !== undefined
      && (!Number.isSafeInteger(payload.beforeRowId) || payload.beforeRowId < 1))) {
    throw Error('授权历史分页参数无效');
  }
  return client.call('approval.list',
    {limit: 50, ...(payload.beforeRowId === undefined ? {} : {beforeRowId: payload.beforeRowId})});
}
