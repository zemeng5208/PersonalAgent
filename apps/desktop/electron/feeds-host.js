import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import * as feeds from '@personal-agent/feeds';

function subscription(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.id)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200
    || typeof value.url !== 'string') throw Error('订阅配置无效');
  let url;
  try {url = new URL(value.url);} catch {throw Error('请填写完整的 RSS / Atom 地址');}
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw Error('订阅地址必须为 HTTP / HTTPS，不支持内嵌账号密码或片段');
  }
  return {id:value.id, title:value.title.trim(), url:url.href, sensitivity:'private'};
}

/** Adapts the existing feed tools to Desktop configuration and session export consent.
 * Subscription URLs stay in encrypted host storage; Runtime still owns Policy and execution.
 */
export function createDesktopFeedsHost({userData, safeStorage, provider = new feeds.HttpFeedProvider()}) {
  const file = path.join(userData, 'feeds-config.json');
  let saved = [], failure = '', allowed = false, active = true, generation = randomUUID();
  let boundRevision, application, release;
  const implementations = [], tools = [], inflight = new Set();
  try {
    if (existsSync(file)) {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.version !== 1 || typeof record.encrypted !== 'string' || !safeStorage.isEncryptionAvailable()) throw Error();
      const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, 'base64')));
      if (!Array.isArray(decoded)) throw Error();
      saved = decoded.map(subscription);
      if (new Set(saved.map(item => item.id)).size !== saved.length) throw Error();
    }
  } catch {saved = []; failure = '订阅配置读取失败，请重新添加';}
  const revision = () => JSON.stringify(saved);
  const current = () => active && allowed && boundRevision === revision() && tools.length > 0;
  const bound = (taskId, claim = false) => {
    if (!application || !taskId) return false;
    const key = 'desktop-feeds-scope';
    if (claim && application.runtime.loadCheckpoint(taskId,key) === undefined) {
      application.runtime.saveCheckpoint(taskId,key,generation);
    }
    return application.runtime.loadCheckpoint(taskId,key) === generation;
  };
  const snapshot = () => ({configured:saved.length > 0, sessionAllowed:allowed,
    available:Boolean(application) && boundRevision === revision() && tools.length > 0,
    subscriptions:saved.map(({id,title}) => ({id,title})),
    requiresRestart:boundRevision !== undefined && boundRevision !== revision(),
    reason:failure || (boundRevision !== undefined && boundRevision !== revision()
      ? '配置已保存，请重启应用接入新的订阅目录'
      : current() ? '已允许本会话读取订阅并交给 AgentArts 汇总；实际调用仍经过 Policy'
      : '添加订阅后允许本会话读取与云端汇总；重启后许可自动关闭')});
  function revoke() {
    allowed = false; generation = randomUUID();
    for (const controller of inflight) controller.abort();
    return snapshot();
  }
  function save(values) {
    if (!active || !safeStorage.isEncryptionAvailable()) throw Error('本机安全存储不可用');
    const encrypted = safeStorage.encryptString(JSON.stringify(values)).toString('base64');
    revoke();
    mkdirSync(userData,{recursive:true});
    writeFileSync(file+'.tmp',JSON.stringify({version:1,encrypted}),'utf8');
    renameSync(file+'.tmp',file); saved = values; failure = '';
    return snapshot();
  }
  function prepare() {
    if (boundRevision !== undefined) return;
    boundRevision = revision();
    if (!saved.length) return;
    if (!['conditional','verified'].includes(provider.verification)) throw Error('需要真实订阅提供者');
    release = feeds.register({register(tool) {implementations.push(tool); return () => {};}},
      {provider, subscriptions:saved});
    for (const tool of implementations) tools.push({descriptor:tool.descriptor,
      async execute(input,context) {
        if (context.signal.aborted || !current() || !bound(context.taskId)) throw Error('订阅读取许可已撤销或任务绑定已改变');
        const controller = new AbortController(); inflight.add(controller);
        try {
          const result = await tool.execute(input,{...context,signal:AbortSignal.any([context.signal,controller.signal])});
          if (!current() || !bound(context.taskId) || controller.signal.aborted || context.signal.aborted) throw Error('订阅读取已撤销');
          return result;
        } finally {inflight.delete(controller);}
      }});
  }
  return {
    snapshot,
    add(input) {
      if (!input || Object.keys(input).some(key => !['title','url'].includes(key))) throw Error('订阅配置格式无效');
      const entry = subscription({...input,id:randomUUID()});
      if (saved.some(item => item.url === entry.url)) throw Error('此订阅已经添加');
      return save([...saved,entry]);
    },
    remove(input) {
      if (!input || Object.keys(input).length !== 1 || typeof input.id !== 'string'
        || !saved.some(item => item.id === input.id)) throw Error('订阅不存在');
      return save(saved.filter(item => item.id !== input.id));
    },
    authorize(input) {
      if (!input || Object.keys(input).length !== 1 || input.readAndCloudConsent !== true
        || !active || !application || !saved.length || boundRevision !== revision() || !tools.length) {
        throw Error('请先完成订阅装配，并确认读取及云端汇总用途');
      }
      revoke(); allowed = true; return snapshot();
    },
    revoke,
    prepare,
    bindApplication(value) {application=value;},
    get tools() {return [...tools];},
    get competitionToolAvailability() {return tools.map(tool => ({toolName:tool.descriptor.name,
      toolVersion:tool.descriptor.version,
      available:({taskId,signal}) => !signal.aborted && current() && bound(taskId,true)}));},
    get competitionToolExports() {return tools.map(tool => ({toolName:tool.descriptor.name,
      toolVersion:tool.descriptor.version, exportPolicyVersion:'authorized-feeds-session-v1',
      accepts:({taskId}) => current() && bound(taskId),
      project:({taskId,result,signal}) => {
        if (signal.aborted || !current() || !bound(taskId)) throw Error('订阅云端许可已失效');
        // The connector already redacts configured URLs. Also check the decoded cursor,
        // whose base64 encoding must not hide credentials reflected in response validators.
        const cursor = result.nextCursor ? feeds.decodeCursor(result.nextCursor) : undefined;
        const text = JSON.stringify({result,cursor});
        for (const item of saved) {
          if (feeds.secretNeedles(new URL(item.url)).some(needle => text.includes(needle))) {
            throw Error('订阅结果包含受保护配置，已停止云端发送');
          }
        }
        if (Buffer.byteLength(JSON.stringify(result),'utf8') > 960 * 1024) throw Error('订阅结果过大，请减小每页数量');
        return structuredClone(result);
      }}));},
    close() {if (!active) return; active=false; revoke(); release?.();},
  };
}
