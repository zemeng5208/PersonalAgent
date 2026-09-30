import {createHash,randomUUID} from 'node:crypto';
import {ProtocolError} from '@personal-agent/contracts';
import {createPublicReferenceExport} from '@personal-agent/mcp';
import {createCloudSkillSelectionPort} from '@personal-agent/skills';

const BINDING='desktop-reference-binding-v1';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal=task=>['succeeded','failed','cancelled'].includes(task.state);

/** Trusted composition of the fixed MCP service and worker-level Skill. */
export function createDesktopReferenceHost({workspace,createMcp,onUpdate=()=>{},assertDispatchBinding,
  publicReferenceExport,publicReferenceAvailability,publicSkillAvailability,resolvePublicSkillSource}) {
  let application,service=createMcp(),binding,configurationRef,closed=false;
  let mutation=Promise.resolve();
  const tasks=new Set();
  const descriptor=service.tools[0].descriptor;
  const current=()=>!closed && binding && workspace.isWorkspaceBindingCurrent(binding)
    && service.health().connected ? configurationRef : undefined;
  let cloudSkill;
  const exporter=createPublicReferenceExport({currentConfigurationRef:current,
    readAuthorization(query) {
      assertTask(query.taskId);
      return publicReferenceExport?.readAuthorization?.(query);
    },
    readConfirmed(query) {
      assertTask(query.taskId);
      return publicReferenceExport?.readConfirmed?.(query);
    }});
  function bindTask(taskId) {
    const ref=current();
    if (!application || !ref) throw Error('请先许可工作区并连接只读参考服务');
    const prior=application.runtime.loadCheckpoint(taskId,BINDING);
    if (prior!==undefined && prior!==ref) throw Error('参考任务的工作区许可已改变');
    if (prior===undefined && !application.runtime.saveCheckpointOnce(taskId,BINDING,ref)) throw Error('参考任务绑定冲突');
    tasks.add(taskId);return ref;
  }
  function assertTask(taskId) {
    if (!current() || application.runtime.loadCheckpoint(taskId,BINDING)!==configurationRef) throw Error('参考任务的工作区许可已撤销或改变');
  }
  const tools=[{descriptor,execute:async(input,context)=>{
    assertTask(context.taskId);
    const active=service,ref=configurationRef;
    const result=await active.tools[0].execute(input,context);
    assertTask(context.taskId);
    if (active!==service || ref!==configurationRef) throw Error('参考读取配置已改变');
    return result;
  }}];
  const competitionToolAvailability=[{toolName:descriptor.name,toolVersion:descriptor.version,
    available:async(input)=>{
      const {taskId,signal}=input;
      if(signal.aborted || !current()) return false;
      try {
        bindTask(taskId);
        // Workspace read permission does not publish private MCP availability.
        const ref=current();
        const allowed=await publicReferenceAvailability?.({...input,configurationRef:ref});
        assertTask(taskId);
        return allowed===true && !signal.aborted && ref===current()
          && Number.isFinite(Date.parse(input.deadline)) && Date.parse(input.deadline)>Date.now();
      } catch {return false;}
    }}];
  const competitionToolExports=[exporter];
  function snapshot() {return {mcp:service.health(),skill:application?.referenceSkillSnapshot()??{health:{state:'unavailable',enabled:false}}};}
  async function stop() {
    cloudSkill?.close();cloudSkill=undefined;
    application?.setReferenceSkillEnabled(false);
    for(const taskId of tasks) {
      const task=application?.runtime.getTask(taskId);
      if(task && !terminal(task)) application.runtime.requestCancel(taskId,'参考资料许可已撤销');
    }
    tasks.clear();binding=undefined;configurationRef=undefined;
    await service.dispose();service=createMcp();onUpdate();
  }
  function serialize(work) {const next=mutation.then(work);mutation=next.catch(()=>{});return next;}
  return {tools,competitionToolAvailability,competitionToolExports,snapshot,bindTask,assertTask,
    configureCloudSkillWorker(versionedSkillworker) {
      cloudSkill?.close();
      cloudSkill=createCloudSkillSelectionPort({versionedSkillworker,resolvePublicSource:input=>{
        assertTask(input.taskId);
        const ref=current();
        const source=resolvePublicSkillSource?.({...input,configurationRef:ref});
        assertTask(input.taskId);
        if(!source || !ref || source.configurationRef!==ref || current()!==ref)
          throw new ProtocolError('UNAUTHORIZED','Native public Skill permission is unavailable');
        return source;
      }});
      return cloudSkill;
    },
    async cloudSkillCatalog(input) {
      if(!cloudSkill || input.signal.aborted || !current()) return undefined;
      try {
        bindTask(input.taskId);const ref=current();
        const allowed=await publicSkillAvailability?.({...input,configurationRef:ref});
        assertTask(input.taskId);
        if(allowed!==true || input.signal.aborted || ref!==current()
          || !Number.isFinite(Date.parse(input.deadline)) || Date.parse(input.deadline)<=Date.now()) return undefined;
        return cloudSkill.describe();
      } catch {return undefined;}
    },
    async dispatchCloudSkillProposal(proposal,context) {
      if(!cloudSkill) throw new ProtocolError('UNSUPPORTED_CAPABILITY','Cloud Skill worker is unavailable');
      bindTask(context.taskId);
      return cloudSkill.dispatch(proposal,context);
    },
    bindApplication(value) {
      application=value;
      application.configureReferenceSkill({enabled:false,isToolAvailable:()=>Boolean(current()),
        currentConfigurationRef:current,assertDispatchBinding:taskId=>{
          bindTask(taskId);assertTask(taskId);
          // The learning owner installs its original binding guard separately.
          return assertDispatchBinding?.(taskId);
        }});
    },
    invalidate:()=>serialize(stop),
    setMcpEnabled(enabled) {return serialize(async()=>{
      if(typeof enabled!=='boolean' || closed) throw Error('参考服务设置无效');
      await stop();
      if(enabled) {
        binding=workspace.readWorkspaceBinding();
        if(!binding) throw Error('请先选择工作区、可信 Node，并许可本会话读取');
        // Reconnecting the same permitted root must not revive prior session
        // receipts or complete Skill caches after stop/revocation.
        configurationRef=digest({binding,connectionId:randomUUID()});
        service=createMcp({rootPath:binding.rootPath,nodeExecutable:binding.nodeExecutable,enabled:true});
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
        try {
          await service.start({signal:controller.signal,deadline:new Date(Date.now()+15000).toISOString()});
          if(!workspace.isWorkspaceBindingCurrent(binding)) throw Error('工作区许可在连接期间已改变');
        } catch(error) {await stop();throw error;} finally {clearTimeout(timer);}
      }
      onUpdate();return snapshot();
    });},
    setSkillEnabled(enabled) {
      if(typeof enabled!=='boolean' || (enabled && !current())) throw Error('请先连接只读参考服务');
      application.setReferenceSkillEnabled(enabled);onUpdate();return snapshot();
    },
    submit({path}) {
      if(!current() || typeof path!=='string') throw Error('参考读取尚未就绪');
      const manifest=application.referenceSkillSnapshot().manifest;
      if(!manifest) throw Error('参考 Skill 尚未装配');
      const task=application.submitReferenceSkillTask({skillId:manifest.id,version:manifest.version,digest:manifest.digest,path,
        idempotencyKey:randomUUID(),deadline:new Date(Date.now()+60000).toISOString()});
      onUpdate();return {taskId:task.taskId,state:task.state};
    },
    async reconcile(taskId) {assertTask(taskId);const task=await application.reconcileReferenceSkillTask(taskId);onUpdate();return {taskId:task.taskId,state:task.state};},
    dispose() {return serialize(async()=>{closed=true;exporter.dispose();await stop();await service.dispose();});},
  };
}
