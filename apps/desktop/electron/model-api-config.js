import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as models from '@personal-agent/models';

const providers = new Set(['pangu', 'openai-compatible']);
const fail = message => { throw Error(message); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : fail('模型配置字段无效');
function endpoint(value) {
  let url;
  try { url = new URL(text(value, 2048)); } catch { fail('模型 Endpoint 无效'); }
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('模型 Endpoint 必须使用 HTTPS，本机服务可使用 HTTP；不能包含凭据或查询参数');
  return url.href.replace(/\/+$/u, '');
}
function validateRecord(value) {
  if (!value || !providers.has(value.provider) || typeof value.enabled !== 'boolean') fail('模型配置无效');
  return {id: text(value.id, 100), provider: value.provider, baseUrl: endpoint(value.baseUrl),
    model: text(value.model, 200), displayName: text(value.displayName, 200), apiKey: text(value.apiKey, 8192)};
}

/** Trusted main process only. Snapshot is safe for IPC; no endpoint is contacted while saving. */
export function createModelApiConfig({userData, safeStorage, modelApi = models}) {
  const target = path.join(userData, 'model-api-config.json');
  let entries = new Map(), defaultId, restoreFailed = false, disposed = false;
  const gateways = new Map();
  const controllers = new Map();
  if (existsSync(target)) {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw Error();
      const envelope = JSON.parse(readFileSync(target, 'utf8'));
      if (envelope.version !== 1 || typeof envelope.encrypted !== 'string') throw Error();
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
      if (!Array.isArray(data.entries) || data.entries.length > 16) throw Error();
      const restored = new Map();
      for (const value of data.entries) {
        const clean = validateRecord(value);
        if (restored.has(clean.id)) throw Error();
        restored.set(clean.id, {...clean, enabled: value.enabled});
      }
      if (data.defaultId !== undefined && (!restored.has(data.defaultId) || !restored.get(data.defaultId).enabled)) throw Error();
      entries = restored; defaultId = data.defaultId;
    } catch {restoreFailed = true;}
  }
  const active = () => {if (disposed) fail('模型配置宿主已释放');};
  const revoke = id => {
    for (const controller of controllers.get(id) ?? []) controller.abort('Model configuration revoked');
    controllers.delete(id); gateways.delete(id);
  };
  const persist = (next, selected) => {
    if (!safeStorage.isEncryptionAvailable()) fail('本机安全存储不可用，未保存模型配置');
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify({entries: [...next.values()], defaultId: selected})).toString('base64');
      mkdirSync(userData, {recursive: true});
      const temporary = `${target}.tmp-${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify({version: 1, encrypted}), {encoding: 'utf8', mode: 0o600});
      renameSync(temporary, target);
    } catch {fail('模型加密配置保存失败');}
  };
  const available = entry => typeof modelApi.ModelGateway === 'function'
    && typeof modelApi.StructuredToolProvider === 'function'
    && typeof modelApi[entry.provider === 'pangu' ? 'PanguModelProvider' : 'OpenAICompatibleModelProvider'] === 'function';
  const snapshot = () => ({
    configured: !disposed && [...entries.values()].some(entry => entry.enabled && available(entry)),
    defaultId: defaultId ?? '',
    status: disposed || restoreFailed ? 'unavailable' : entries.size ? 'configured' : 'unconfigured',
    reason: disposed ? '模型配置宿主已释放' : restoreFailed ? '模型加密配置无法读取，请重新保存'
      : '用于 AgentArts 委派的辅助子任务；保存不代表真实连接已验证',
    models: [...entries.values()].map(({id, provider, baseUrl, model, displayName, enabled}) => ({
      id, provider, baseUrl, model, displayName, enabled,
      available: !disposed && enabled && available(entries.get(id)),
      verification: 'conditional', keyConfigured: true,
      capabilities: {text: true, tools: 'structured-json', nativeToolCalling: false, nativeReasoning: false},
      reasoningEfforts: [],
    })),
  });
  function getModelGateway(modelName) {
    active();
    const id = modelName === undefined || modelName === '' ? defaultId : modelName;
    const entry = entries.get(id);
    if (!entry?.enabled || !available(entry)) return undefined;
    if (gateways.has(id)) return gateways.get(id);
    const assertCurrent = () => {
      if (disposed || entries.get(id) !== entry || !entry.enabled) fail('模型配置已撤销或更改');
    };
    const Provider = modelApi[entry.provider === 'pangu' ? 'PanguModelProvider' : 'OpenAICompatibleModelProvider'];
    const provider = new modelApi.StructuredToolProvider(new Provider({baseUrl: entry.baseUrl,
      model: entry.model, deployment: entry.id, apiKey: () => {assertCurrent(); return entry.apiKey;}}));
    const gateway = new modelApi.ModelGateway({deployment: provider.deployment, async complete(request) {
      assertCurrent();
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      const pending = controllers.get(id) ?? new Set();
      controllers.set(id, pending); pending.add(controller);
      request.signal.addEventListener('abort', abort, {once: true});
      if (request.signal.aborted) abort();
      try {
        const result = await provider.complete({...request, signal: controller.signal});
        assertCurrent();
        return result;
      } finally {
        request.signal.removeEventListener('abort', abort); pending.delete(controller);
      }
    }});
    gateways.set(id, gateway);
    return gateway;
  }
  return Object.freeze({
    snapshot, getModelGateway,
    getModelReasoningEfforts: () => [],
    configure(input) {
      active();
      if (!input || Object.keys(input).some(key => !['id', 'provider', 'baseUrl', 'model', 'displayName', 'apiKey', 'enabled', 'makeDefault'].includes(key))
        || (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean')
        || (input.enabled !== undefined && typeof input.enabled !== 'boolean')
        || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) fail('模型配置字段无效');
      const id = input.id === undefined || input.id === '' ? `model-${randomUUID()}` : text(input.id, 100);
      const previous = entries.get(id);
      const baseUrl = endpoint(input.baseUrl);
      const sameDestination = previous?.provider === input.provider && previous?.baseUrl === baseUrl;
      const entry = {...validateRecord({...input, id, baseUrl, enabled: input.enabled ?? previous?.enabled ?? true,
        apiKey: input.apiKey?.trim() || (sameDestination ? previous.apiKey : '')}),
        enabled: input.enabled ?? previous?.enabled ?? true};
      const next = new Map(entries); next.set(id, entry);
      if (next.size > 16) fail('最多保存 16 个辅助模型');
      let selected = input.makeDefault === true ? id
        : input.makeDefault === false && defaultId === id ? undefined
          : defaultId ?? (input.makeDefault !== false && entry.enabled ? id : undefined);
      if (selected && !next.get(selected)?.enabled) selected = undefined;
      persist(next, selected); revoke(id); entries = next; defaultId = selected; restoreFailed = false;
      return snapshot();
    },
    remove(input) {
      active();
      if (!input || Object.keys(input).some(key => key !== 'id')) fail('删除模型参数无效');
      const id = text(input.id, 100);
      const next = new Map(entries); next.delete(id);
      const selected = defaultId === id ? undefined : defaultId;
      persist(next, selected); revoke(id); entries = next; defaultId = selected;
      return snapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of entries.keys()) revoke(id);
      entries.clear(); defaultId = undefined;
    },
  });
}
