/** Fixed user text from the trusted adapter's existing allowlisted receipt. */
export function agentArtsFailureNotice(receipt) {
  if (receipt?.stage !== 'http_response' || receipt.code !== 'EXTERNAL_FAILURE'
    || ![401, 403].includes(receipt.httpStatus)) return '';
  return `AgentArts 网关拒绝过一次云端协调请求（HTTP ${receipt.httpStatus}）。请检查 API Key 和调用权限。`;
}
