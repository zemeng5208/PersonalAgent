const REGIONS = new Set(['cn-north-4', 'cn-east-3']);
const ENDPOINT = 'https://iam.myhuaweicloud.com/v3/auth/tokens?nocatalog=true';
const RESPONSE_LIMIT = 65_536;

async function readResponse(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw Error();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    while (true) {
      if (signal.aborted) throw Error();
      const part = await reader.read();
      if (signal.aborted) throw Error();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_LIMIT) throw Error();
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Trusted host only. Password is used once against Huawei IAM and never persisted. */
export async function acquireHuaweiSisToken(input, {fetchImpl = globalThis.fetch,
  now = Date.now, timeoutMs = 30_000} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['region', 'domainName', 'username', 'password'].includes(key))
    || !REGIONS.has(input.region)
    || ![input.domainName, input.username].every(value => typeof value === 'string'
      && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\r\n\0]/.test(value))
    || typeof input.password !== 'string' || !input.password || input.password.length > 1024) {
    throw Error('请填写华为云账号名、IAM 用户名和密码，并选择 SIS 区域');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {method: 'POST', redirect: 'error', signal,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({auth: {identity: {methods: ['password'], password: {user: {
        domain: {name: input.domainName}, name: input.username, password: input.password,
      }}}, scope: {project: {name: input.region}}}})});
  } catch {
    throw Error(signal.aborted ? '华为 IAM 登录超时，请稍后重试' : '无法连接华为 IAM，请检查网络');
  }
  if (response.status !== 201) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401) throw Error('华为 IAM 登录失败，请检查账号名、IAM 用户名和密码');
    if (response.status === 403) throw Error('该 IAM 用户没有所选区域的访问权限，请检查编程访问及项目授权');
    if (response.status === 429) throw Error('华为 IAM 请求过于频繁，请稍后重试');
    throw Error('华为 IAM 暂未签发令牌，请稍后重试');
  }
  try {
    const body = await readResponse(response, signal);
    const token = response.headers.get('x-subject-token');
    const project = body?.token?.project;
    const expiry = body?.token?.expires_at;
    if (project?.name !== input.region || !/^[a-f0-9]{32}$/i.test(project.id)
      || body?.token?.user?.name !== input.username
      || !token || token.length > 16_384 || token.trim() !== token || /[\r\n]/.test(token)
      || typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(expiry)
      || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now() + 60_000) throw Error();
    return {region: input.region, projectId: project.id, iamToken: token, tokenExpiresAt: expiry};
  } catch {
    throw Error(signal.aborted ? '华为 IAM 登录超时，请稍后重试' : '华为 IAM 返回的项目令牌无效，配置未保存');
  }
}
