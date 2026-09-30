import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
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
  return {id:value.id, title:value.title.trim(), url:url.href,
    sensitivity:value.sensitivity === 'public' ? 'public' : 'private'};
}

/** Adapts the existing feed tools to Desktop configuration and session export consent.
 * Subscription URLs stay in encrypted host storage; Runtime still owns Policy and execution.
 */
export function createDesktopFeedsHost({userData, safeStorage, provider = new feeds.HttpFeedProvider(), now = Date.now}) {
  const file = path.join(userData, 'feeds-config.json');
  let saved = [], failure = '', allowed = false, active = true, generation = randomUUID();
  let boundRevision, application, release, namespace, grantStore;
  const implementations = [], tools = [], inflight = new Set(), sourceReceipts = new Map();
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
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function sourceBinding(subscriptionId) {
    const item = saved.find(entry => entry.id === subscriptionId);
    if (!active || !namespace || !item || typeof feeds.feedConfigBinding !== 'function') return null;
    const url = new URL(item.url);
    return {namespace, subscriptionId:item.id, sourceId:item.id,
      configurationRef:feeds.feedConfigBinding(item,provider.source),
      generation, provider:provider.source, transport:url.protocol.slice(0,-1),
      knownUrlDigest:hash(item.url), containsCredentials:Boolean(url.username || url.password || url.search),
      sensitivity:item.sensitivity, available:current(), transportVerified:false};
  }
  function taskBinding(taskId, allowCompleted = false) {
    if (!application || typeof taskId !== 'string' || !taskId || taskId.length > 256) throw Error('请选择原始任务');
    const task = application.runtime.getTask(taskId);
    if (![`desktop-panel`,`desktop-workspace`,`host-tool:${namespace}`,`knowledge-watch:${namespace}`].includes(task.conversationId)
      || task.cancelRequested || ['failed','cancelled'].includes(task.state)
      || (!allowCompleted && task.state === 'succeeded')) throw Error('任务不属于当前用户或已经停止');
    const deadline = application.runtime.loadCheckpoint(taskId,'application-deadline')
      ?? application.runtime.loadCheckpoint(taskId,'host-tool-intent')?.deadline;
    if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= now()) {
      throw Error('原任务没有有效期限');
    }
    return {taskId, conversationId:task.conversationId, deadline, purposeDigest:hash(task.goal),goal:task.goal};
  }
  const grantKey = (sourceId,taskId) => 'feed-source-grant:' + hash({sourceId,taskId});
  function readTrackingGrant(query) {
    const absent = {state:'none',id:'feed-scope-unavailable',revision:1,publicLowRiskTracking:false,
      expiresAt:new Date(now()).toISOString()};
    if (!grantStore || query?.namespace !== namespace || typeof query?.sourceId !== 'string'
      || typeof query?.taskId !== 'string') return absent;
    try {
      const binding = sourceBinding(query.sourceId), task = taskBinding(query.taskId,true);
      const grant = grantStore.get(grantKey(query.sourceId,query.taskId));
      if (!grant || grant.state !== 'granted' || binding?.sensitivity !== 'public' || binding.containsCredentials
        || !binding.available || grant.configurationRef !== binding.configurationRef
        || grant.namespace !== namespace || grant.sourceId !== query.sourceId || grant.taskId !== task.taskId
        || grant.conversationId !== task.conversationId || grant.purposeDigest !== task.purposeDigest
        || grant.expiresAt !== task.deadline
        || Date.parse(grant.expiresAt) <= now()) return absent;
      return structuredClone(grant);
    } catch { return absent; }
  }
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
    subscriptions:saved.map(({id,title,sensitivity}) => ({id,title,sensitivity})),
    requiresRestart:boundRevision !== undefined && boundRevision !== revision(),
    reason:failure || (boundRevision !== undefined && boundRevision !== revision()
      ? '配置已保存，请重启应用接入新的订阅目录'
      : current() ? '已允许本会话读取订阅并交给 AgentArts 汇总；实际调用仍经过 Policy'
      : '添加订阅后允许本会话读取与云端汇总；重启后许可自动关闭')});
  function revoke(revokeTracking = true) {
    allowed = false; generation = randomUUID();
    for (const controller of inflight) controller.abort();
    sourceReceipts.clear();
    if (revokeTracking && grantStore) {
      const keys = grantStore.get('feed-source-grant-index');
      for (const key of Array.isArray(keys) ? keys : []) {
        if (typeof key !== 'string' || !/^feed-source-grant:[a-f0-9]{64}$/.test(key)) continue;
        const grant = grantStore.get(key);
        if (grant?.state === 'granted') grantStore.set(key,{...grant,state:'revoked',
          publicLowRiskTracking:false,revision:grant.revision+1});
      }
    }
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
    registerCurrentSources();
    for (const tool of implementations) tools.push({descriptor:tool.descriptor,
      async execute(input,context) {
        if (context.signal.aborted || !current() || !bound(context.taskId)) throw Error('订阅读取许可已撤销或任务绑定已改变');
        const executing=implementations.find(item=>item.descriptor.name === tool.descriptor.name
          && item.descriptor.version === tool.descriptor.version);
        if (!executing) throw Error('订阅当前实例不可用');
        const config=input?.subscriptionId ? sourceBinding(input.subscriptionId) : null;
        const controller = new AbortController(); inflight.add(controller);
        try {
          const result = await executing.execute(input,{...context,signal:AbortSignal.any([context.signal,controller.signal])});
          if (!current() || !bound(context.taskId) || controller.signal.aborted || context.signal.aborted) throw Error('订阅读取已撤销');
          if (result?.sourceReceipt) {
            if (!config || typeof feeds.assertFeedSourceReceiptMatches !== 'function') throw Error('订阅来源收据验证不可用');
            feeds.assertFeedSourceReceiptMatches(result.sourceReceipt,result,
              {subscriptionId:config.subscriptionId,configBinding:config.configurationRef});
            sourceReceipts.set(config.subscriptionId,structuredClone(result.sourceReceipt));
          }
          return result;
        } finally {inflight.delete(controller);}
      }});
  }
  function registerCurrentSources() {
    if (!['conditional','verified'].includes(provider.verification)) throw Error('需要真实订阅提供者');
    const next=[];
    const nextRelease=feeds.register({register(tool) {next.push(tool);return () => {};}},
      {provider,subscriptions:saved,trackRevisions:true,isPaused:()=>!active || !allowed});
    if (tools.length && !isDeepStrictEqual(next.map(item=>item.descriptor),tools.map(item=>item.descriptor))) {
      nextRelease();throw Error('订阅目录定义已经改变，请重启接入');
    }
    release?.();release=nextRelease;implementations.splice(0,implementations.length,...next);
    boundRevision=revision();
  }
  return {
    snapshot,
    // Host-only facts and native consent. None of these methods are exposed directly over IPC.
    readSourceBinding:sourceBinding,
    readSourceReceipt:subscriptionId=>sourceReceipts.has(subscriptionId)
      ? structuredClone(sourceReceipts.get(subscriptionId)) : undefined,
    readTrackingGrant,
    prepareNativeSourceChoice({subscriptionId,taskId}) {
      const binding = sourceBinding(subscriptionId), task = taskBinding(taskId);
      if (!binding || !grantStore) throw Error('订阅来源尚未装配');
      const item = saved.find(entry => entry.id === subscriptionId);
      return {...binding,...task,title:item.title,url:item.url};
    },
    applyNativeSourceChoice(choice, classification) {
      if (!['public','private'].includes(classification) || !grantStore || !choice) throw Error('来源分类无效');
      const binding = sourceBinding(choice.subscriptionId), task = taskBinding(choice.taskId);
      if (!binding || binding.configurationRef !== choice.configurationRef || binding.generation !== choice.generation
        || task.conversationId !== choice.conversationId || task.deadline !== choice.deadline
        || task.purposeDigest !== choice.purposeDigest) throw Error('来源或原任务已改变');
      if (classification === 'public' && binding.containsCredentials) throw Error('含查询参数或凭据的来源不能作为公开跟踪源');
      const key = grantKey(binding.sourceId,task.taskId), previous = grantStore.get(key);
      if (saved.find(item => item.id === binding.sourceId).sensitivity !== classification) {
        save(saved.map(item => item.id === binding.sourceId ? {...item,sensitivity:classification} : item));
        registerCurrentSources();
      }
      const currentBinding = sourceBinding(binding.sourceId);
      grantStore.set(key,{state:classification === 'public' ? 'granted' : 'revoked',id:randomUUID(),
        revision:Number.isSafeInteger(previous?.revision) ? previous.revision+1 : 1,
        namespace,sourceId:binding.sourceId,subscriptionId:binding.subscriptionId,
        configurationRef:currentBinding.configurationRef,taskId:task.taskId,conversationId:task.conversationId,
        purposeDigest:task.purposeDigest,
        publicLowRiskTracking:classification === 'public',expiresAt:task.deadline,
        classifiedAt:new Date(now()).toISOString(),classificationSource:'native-user-choice'});
      const index = grantStore.get('feed-source-grant-index');
      grantStore.set('feed-source-grant-index',[...new Set([...(Array.isArray(index) ? index : []),key])]);
      return snapshot();
    },
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
      revoke(false); allowed = true; return snapshot();
    },
    revoke:() => revoke(),
    prepare,
    bindApplication(value, identity) {
      application=value;
      if (typeof identity === 'string' && identity.trim()) {
        namespace=identity; grantStore=value.createHostStateStore('knowledge-tracking');
      }
    },
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
    close() {if (!active) return; active=false; revoke(false); release?.();},
  };
}
