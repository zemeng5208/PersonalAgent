// Desktop-only presentation state; the Runtime wire result remains unchanged.
export async function readCapabilityDirectory(client) {
  try {
    const result = await client.call('capability.list', {});
    return {
      manifests: result.manifests,
      health: result.health,
      status: {state: 'loaded', reason: result.manifests.length
        ? `Runtime 已公布 ${result.manifests.length} 项能力`
        : 'Runtime 已返回空能力目录'},
    };
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_CAPABILITY') {
      return {manifests: [], health: [], status: {
        state: 'unavailable', reason: 'Runtime 未公布 capability.list，无法读取能力与连接健康',
      }};
    }
    const code = ['TIMEOUT', 'PROTOCOL_MISMATCH', 'UNAUTHORIZED', 'EXTERNAL_FAILURE']
      .includes(error?.code) ? `（${error.code}）` : '';
    return {manifests: [], health: [], status: {
      state: 'error', reason: `能力目录读取失败${code}；请检查 Runtime 连接后重试`,
    }};
  }
}
