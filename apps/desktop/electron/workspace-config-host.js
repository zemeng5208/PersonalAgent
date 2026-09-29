import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import * as coding from '@personal-agent/coding-tools';
import {createDesktopCodingToolHost} from './coding-tool-host.js';

function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('\\\\')
    || lstatSync(value).isSymbolicLink()) throw Error('请选择本机普通目录');
  const root = realpathSync.native(value);
  if (!statSync(root).isDirectory() || root === path.parse(root).root) throw Error('不能将整个磁盘作为编程工作区');
  return root;
}
function fixedNode(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('\\\\')
    || lstatSync(value).isSymbolicLink()) throw Error('请选择本机 Node 可执行文件');
  const executable=realpathSync.native(value);
  if (!statSync(executable).isFile() || path.basename(executable).toLowerCase()
    !== (process.platform==='win32'?'node.exe':'node')) {
    throw Error('请选择 Node 可执行文件');
  }
  const relative=path.relative(root,executable);
  if (relative==='' || (relative!=='..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))) throw Error('Node 可执行文件必须位于工作区外');
  return executable;
}
function outsideFile(value,root,name) {
  if(typeof value!=='string' || !path.isAbsolute(value) || value.startsWith('\\\\')
    || lstatSync(value).isSymbolicLink()) throw Error(`请选择本机${name}文件`);
  const file=realpathSync.native(value);
  if(!statSync(file).isFile()) throw Error(`请选择本机${name}普通文件`);
  const relative=path.relative(root,file);
  if(relative==='' || (relative!=='..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))) throw Error(`${name}文件必须位于工作区外`);
  return file;
}
function fixedNpmCli(value,root) {
  const file=outsideFile(value,root,'npm');
  if(path.basename(file).toLowerCase()!=='npm-cli.js') throw Error('请选择 npm-cli.js');
  return file;
}
function derivedNpmCli(node,root) {
  try {return fixedNpmCli(path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js'),root);}
  catch {return undefined;}
}
function checkFile(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('\\\\')
    || lstatSync(value).isSymbolicLink()) throw Error('请选择工作区内普通文件');
  const target=realpathSync.native(value);
  if (!statSync(target).isFile() || !/\.(?:c?js|mjs)$/i.test(target)) throw Error('请选择工作区内 JavaScript 文件');
  const relative=path.relative(root,target);
  if (!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Error('检查文件必须位于选定工作区内');
  }
  return relative.split(path.sep).join('/');
}
function executable(name) {
  try {
    const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    const found = execFileSync(where, [name], {encoding:'utf8',windowsHide:true,timeout:3000})
      .trim().split(/\r?\n/)[0];
    return realpathSync.native(found);
  } catch {return undefined;}
}
function recoveryDirectory(userData, root, powerShell) {
  const target = path.join(userData, 'coding-recovery', createHash('sha256').update(root).digest('hex'));
  if (!existsSync(target)) {
    mkdirSync(target, {recursive:true});
    const script = String.raw`$ErrorActionPreference='Stop'
$target=[Console]::In.ReadToEnd()
$self=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($self)
$acl.SetAccessRuleProtection($true,$false)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($self,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl`;
    execFileSync(powerShell, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],
    {input:target,encoding:'utf8',windowsHide:true,timeout:10000,stdio:['pipe','pipe','pipe']});
  }
  return target;
}

/** Persist only a selected directory. Execution/export consent expires with this process.
 * Registered implementations stay pinned until restart; changing settings revokes them first.
 */
export function createWorkspaceConfigHost({userData,safeStorage,selectDirectory,
  selectNodeExecutable,selectCheckFile,selectNpmCli,jobHelperExecutable,
  projectScriptEnvSource,createCommandRecipeTool}) {
  const file = path.join(userData,'coding-workspace.json');
  let savedRoot,savedNode,savedCheckFile,savedNpmCli,boundRoot,boundProjectHelper,rootIdentity,application,active=true,consent,applyHost,failure='',commandFailure='',projectFailure='';
  let generation=randomUUID();
  const implementations=[];
  const inflight=new Set();
  try {
    if (existsSync(file)) {
      if (!safeStorage.isEncryptionAvailable()) throw Error();
      const record=JSON.parse(readFileSync(file,'utf8'));
      if (record.version!==1 || typeof record.encrypted!=='string') throw Error();
      savedRoot=directory(safeStorage.decryptString(Buffer.from(record.encrypted,'base64')));
      try {
        if(record.encryptedNode!==undefined) {
          if(typeof record.encryptedNode!=='string') throw Error();
          savedNode=fixedNode(safeStorage.decryptString(Buffer.from(record.encryptedNode,'base64')),savedRoot);
        }
        if(record.encryptedCheckFile!==undefined) {
          if(typeof record.encryptedCheckFile!=='string') throw Error();
          const selected=safeStorage.decryptString(Buffer.from(record.encryptedCheckFile,'base64'));
          if(typeof selected!=='string' || path.isAbsolute(selected) || selected.startsWith('..')) throw Error();
          savedCheckFile=checkFile(path.resolve(savedRoot,selected),savedRoot);
        }
      } catch {commandFailure='Node 检查配置已失效，请重新选择可执行文件或工作区文件';}
      try {
        if(record.encryptedNpmCli!==undefined) {
          if(typeof record.encryptedNpmCli!=='string') throw Error();
          savedNpmCli=fixedNpmCli(safeStorage.decryptString(Buffer.from(record.encryptedNpmCli,'base64')),savedRoot);
        } else if(savedNode) savedNpmCli=derivedNpmCli(savedNode,savedRoot);
      } catch {projectFailure='项目命令配置已失效，请重新选择 npm 文件';}
    }
  } catch {failure='工作区加密配置不可用，请重新选择目录';}
  if (savedRoot) {
    try {
      boundRoot=savedRoot; rootIdentity=statSync(boundRoot,{bigint:true});
      const options={rootPath:boundRoot};
      implementations.push(coding.createWorkspaceReadTool(options), coding.createWorkspaceListTool({rootPath:boundRoot}),
        coding.createWorkspacePatchPreviewTool(options),coding.createWorkspacePatchStageTool(options));
      const pwsh=executable('pwsh.exe');
      if (pwsh) {
        try {
          applyHost=createDesktopCodingToolHost({workspaceRoot:boundRoot,authorizedWorkspaceRoot:boundRoot,
            recoveryRootPath:recoveryDirectory(userData,boundRoot,pwsh),powerShellPath:pwsh,
            createWorkspacePatchApplyTool:coding.createWorkspacePatchApplyTool,
            reconcileWorkspacePatchApply:coding.reconcileWorkspacePatchApply});
          implementations.push(...applyHost.tools);
        } catch {failure='读取和候选生成可用；安全应用补丁所需的目录或 PowerShell 检查未通过';}
      } else failure='读取和候选生成可用；安全应用补丁需要 PowerShell 7';
      const git=executable('git.exe');
      if (git) {
        const command=coding.createWorkspaceCommandTool({rootPath:boundRoot,recipes:[{id:'git-diff-check',
          executable:git,args:['--no-pager','-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--check']}],
          maxOutputBytes:4096,maxDurationMs:30000});
        implementations.push({descriptor:{...command.descriptor,name:'workspace.git_diff_check',
          inputSchema:{type:'object',properties:{},additionalProperties:false}},
          execute:(_input,context) => command.execute({recipeId:'git-diff-check'},context)});
      }
      let helper;
      if(jobHelperExecutable) {
        try {
          helper=outsideFile(jobHelperExecutable,boundRoot,'项目命令');
          if(path.basename(helper).toLowerCase()!=='windowsjobprocesshost.exe') throw Error();
          boundProjectHelper=helper;
        } catch {projectFailure='项目命令所需的本机组件不可用';}
      }
      const projectRequested=Boolean(helper && savedNpmCli);
      if (savedNode && (savedCheckFile || projectRequested) && typeof createCommandRecipeTool==='function') {
        try {
          const commandImplementations=[];
          const options={workspaceRoot:boundRoot,authorizedWorkspaceRoot:boundRoot,
            nodeExecutable:savedNode,checkFiles:[{id:'node-check',path:savedCheckFile}],
            allowProjectScripts:projectRequested,jobHelperExecutable:helper,npmCliPath:savedNpmCli,
            projectScriptEnvSource,maxOutputBytes:4096,maxDurationMs:30000,required:false};
          if(!savedCheckFile) options.checkFiles=[];
          let recipe;
          try {recipe=createCommandRecipeTool(options);}
          catch (error) {
            if(!projectRequested) throw error;
            projectFailure='项目命令暂不可用；Node 语法检查仍可用';
            recipe=createCommandRecipeTool({...options,allowProjectScripts:false});
          }
          if (!recipe?.tool || !Array.isArray(recipe.recipes)
            || recipe.tool.descriptor.name!=='workspace.run_allowed_command'
            || recipe.tool.descriptor.sideEffect!=='local_write'
            || recipe.tool.descriptor.requiredScopes?.length!==1
            || recipe.tool.descriptor.requiredScopes[0]!=='workspace:execute') throw Error();
          const nodeRecipe=recipe.recipes.find(item=>item.id==='node-check');
          if(savedCheckFile) {
            if(!nodeRecipe || nodeRecipe.executable!==savedNode
              || nodeRecipe.args?.length!==2 || nodeRecipe.args[0]!=='--check'
              || nodeRecipe.args[1]!==savedCheckFile) throw Error();
            commandImplementations.push({descriptor:{...recipe.tool.descriptor,name:'workspace.node_check',
              inputSchema:{type:'object',properties:{},additionalProperties:false}},
              execute:(_input,context)=>recipe.tool.execute({recipeId:'node-check'},context)});
          }
          if(projectRequested && recipe.diagnostics?.projectScriptsExposed===true) {
            for(const [id,name,script] of [['npm-build','workspace.npm_build','build'],
              ['npm-test','workspace.npm_test','test']]) {
              const fixed=recipe.recipes.find(item=>item.id===id);
              if(!fixed) continue;
              if(fixed.executable!==helper || !Array.isArray(fixed.args)
                || fixed.args.length!==8 || fixed.args[0]!=='--cwd' || fixed.args[1]!==boundRoot
                || fixed.args[2]!=='--exe' || fixed.args[3]!==savedNode
                || fixed.args[4]!=='--' || fixed.args[5]!==savedNpmCli
                || fixed.args[6]!=='run' || fixed.args[7]!==script) throw Error();
              commandImplementations.push({descriptor:{...recipe.tool.descriptor,name,
                inputSchema:{type:'object',properties:{},additionalProperties:false}},
                execute:(_input,context)=>recipe.tool.execute({recipeId:id},context)});
            }
          }
          if(projectRequested && !commandImplementations.some(item=>item.descriptor.name.startsWith('workspace.npm_'))
            && !projectFailure) projectFailure='工作区构建或测试命令暂不可用';
          implementations.push(...commandImplementations);
        } catch {commandFailure='Node 检查装配失败；读取和其他已配置能力仍可用';}
      } else if (savedNode && (savedCheckFile || projectRequested)) commandFailure='命令实现尚未接入；读取和其他已配置能力仍可用';
      if(savedNpmCli && !projectRequested && !projectFailure) projectFailure='项目构建与测试尚未准备好';
    } catch {implementations.length=0; failure='选定工作区无法安全装配，请重新选择目录';}
  }
  const identityCurrent=() => {
    try {const now=statSync(boundRoot,{bigint:true});return savedRoot===boundRoot
      && directory(boundRoot)===boundRoot && now.dev===rootIdentity.dev && now.ino===rootIdentity.ino
      && now.birthtimeNs===rootIdentity.birthtimeNs;} catch {return false;}
  };
  const isProject=tool=>['workspace.npm_build','workspace.npm_test'].includes(tool.descriptor.name);
  const projectIdentityCurrent=()=> {
    try {return savedNode && fixedNode(savedNode,boundRoot)===savedNode
      && savedNpmCli && fixedNpmCli(savedNpmCli,boundRoot)===savedNpmCli
      && boundProjectHelper && outsideFile(boundProjectHelper,boundRoot,'项目命令')===boundProjectHelper;}
    catch {return false;}
  };
  const enabled=tool => active && consent?.cloudExportAllowed===true && identityCurrent()
    && (tool.descriptor.sideEffect==='read' || (isProject(tool)
      ? consent.commandAllowed===true && consent.projectCodeAllowed===true && projectIdentityCurrent()
      : ['workspace.git_diff_check','workspace.node_check'].includes(tool.descriptor.name)
        ? consent.commandAllowed===true : consent.writeAllowed===true))
    && (tool.descriptor.name!=='workspace.apply_text_patch' || applyHost?.available());
  const bound=(taskId, claim=false) => {
    if (!application || !taskId) return false;
    const key='desktop-coding-scope';
    const previous=application.runtime.loadCheckpoint(taskId,key);
    if (previous===undefined && claim) application.runtime.saveCheckpoint(taskId,key,generation);
    return application.runtime.loadCheckpoint(taskId,key)===generation;
  };
  const tools=implementations.map(tool => ({descriptor:tool.descriptor,execute:async(input,context) => {
    if (!enabled(tool) || !bound(context.taskId)) throw Error('工作区许可已撤销或任务绑定已改变');
    const controller=new AbortController();inflight.add(controller);
    try {return await tool.execute(input,{...context,signal:AbortSignal.any([context.signal,controller.signal])});}
    finally {inflight.delete(controller);}
  }}));
  const snapshot=() => ({configured:Boolean(savedRoot),displayName:savedRoot?path.basename(savedRoot):'',
    nodeConfigured:Boolean(savedNode),checkFileConfigured:Boolean(savedCheckFile),npmCliConfigured:Boolean(savedNpmCli),
    checkFileName:savedCheckFile?path.basename(savedCheckFile):'',
    nodeCheckAvailable:tools.some(tool=>tool.descriptor.name==='workspace.node_check' && enabled(tool)),
    projectScriptsAvailable:tools.some(isProject) && projectIdentityCurrent()===true,
    projectCommands:tools.filter(isProject).map(tool=>tool.descriptor.name==='workspace.npm_build'?'build':'test'),
    projectCodeAllowed:consent?.projectCodeAllowed===true,
    commandReason:commandFailure,projectReason:projectFailure,
    readAvailable:tools.some(tool=>tool.descriptor.name==='workspace.read_text') && enabled(tools[0]),
    writeAvailable:tools.some(tool=>tool.descriptor.name==='workspace.apply_text_patch' && enabled(tool)),
    commandAvailable:tools.some(tool=>['workspace.git_diff_check','workspace.node_check'].includes(tool.descriptor.name) && enabled(tool)),
    cloudExportAllowed:consent?.cloudExportAllowed===true,
    reason:savedRoot!==boundRoot?'目录已保存，请重启应用完成工具装配后授权':failure || (consent
      ? '当前工作区已授权；受限命令仍经过 Policy，项目脚本另需明确许可'
      : savedRoot?'请为本次应用会话授权工作区；重启后需要重新授权':'请选择编程工作区')});
  const revoke=() => {
    consent=undefined;generation=randomUUID();
    for (const controller of inflight) controller.abort();
    return snapshot();
  };
  function persist(root,node,selectedFile,npmCli) {
    if (!safeStorage.isEncryptionAvailable()) throw Error('本机安全存储不可用');
    const record={version:1,encrypted:safeStorage.encryptString(root).toString('base64'),
      ...(node?{encryptedNode:safeStorage.encryptString(node).toString('base64')}:{}),
      ...(selectedFile?{encryptedCheckFile:safeStorage.encryptString(selectedFile).toString('base64')}:{}),
      ...(npmCli?{encryptedNpmCli:safeStorage.encryptString(npmCli).toString('base64')}:{})};
    mkdirSync(userData,{recursive:true});
    writeFileSync(file+'.tmp',JSON.stringify(record),'utf8');renameSync(file+'.tmp',file);
  }
  return {tools,snapshot,
    patchReconciliation:applyHost?.patchReconciliation,
    bindApplication(value){application=value;},
    async select() {
      const selected=await selectDirectory();
      if (!selected) return snapshot();
      const root=directory(selected);
      let node;
      try {node=savedNode?fixedNode(savedNode,root):undefined;} catch {node=undefined;}
      let npmCli;
      try {npmCli=savedNpmCli?fixedNpmCli(savedNpmCli,root):undefined;} catch {npmCli=undefined;}
      persist(root,node,undefined,npmCli);revoke();savedRoot=root;savedNode=node;savedCheckFile=undefined;savedNpmCli=npmCli;
      commandFailure='';projectFailure='';return snapshot();
    },
    async selectNode() {
      if(!savedRoot || typeof selectNodeExecutable!=='function') throw Error('请先选择工作区并使用本机 Node 选择器');
      const selected=await selectNodeExecutable();if(!selected) return snapshot();
      const node=fixedNode(selected,savedRoot);
      const npmCli=derivedNpmCli(node,savedRoot);
      persist(savedRoot,node,savedCheckFile,npmCli);revoke();savedNode=node;savedNpmCli=npmCli;
      commandFailure='';projectFailure='';return snapshot();
    },
    async selectCheckFile() {
      if(!savedRoot || typeof selectCheckFile!=='function') throw Error('请先选择工作区并使用本机文件选择器');
      const selected=await selectCheckFile(savedRoot);if(!selected) return snapshot();
      const relative=checkFile(selected,savedRoot);
      persist(savedRoot,savedNode,relative,savedNpmCli);revoke();savedCheckFile=relative;commandFailure='';return snapshot();
    },
    async selectNpmCli() {
      if(!savedRoot || !savedNode || typeof selectNpmCli!=='function') throw Error('请先选择工作区与 Node');
      const selected=await selectNpmCli();if(!selected) return snapshot();
      const npmCli=fixedNpmCli(selected,savedRoot);
      persist(savedRoot,savedNode,savedCheckFile,npmCli);revoke();savedNpmCli=npmCli;
      projectFailure='';return snapshot();
    },
    authorize(input) {
      if (!input || Array.isArray(input) || input.cloudExportAllowed!==true || typeof input.writeAllowed!=='boolean'
        || typeof input.commandAllowed!=='boolean'
        || (input.projectCodeAllowed!==undefined && typeof input.projectCodeAllowed!=='boolean')
        || Object.keys(input).some(k=>!['cloudExportAllowed','writeAllowed','commandAllowed','projectCodeAllowed'].includes(k))) throw Error('请确认工作区权限');
      if(input.projectCodeAllowed===true && (!input.commandAllowed || !snapshot().projectScriptsAvailable)) {
        throw Error('项目构建和测试尚未准备好，不能授权执行');
      }
      if (!identityCurrent() || !tools.length) throw Error('请先选择目录并重启完成装配');
      revoke();consent={...input};return snapshot();
    },
    revoke,
    competitionToolAvailability:tools.map(tool=>({toolName:tool.descriptor.name,toolVersion:tool.descriptor.version,
      available:({taskId,signal})=>!signal.aborted && enabled(tool) && bound(taskId,true)})),
    competitionToolExports:tools.map(tool=>({toolName:tool.descriptor.name,toolVersion:tool.descriptor.version,
      exportPolicyVersion:isProject(tool)?'authorized-project-script-redacted-v1'
        :tool.descriptor.name==='workspace.node_check'
          ? 'authorized-node-check-redacted-v1':'authorized-coding-session-v1',
      accepts:({taskId})=>enabled(tool) && bound(taskId),
      project:({taskId,result,signal})=> {
        if (signal.aborted || !enabled(tool) || !bound(taskId)) throw Error('工作区出云许可已失效');
        if (tool.descriptor.name==='workspace.node_check' || isProject(tool)) {
          const recipeId=isProject(tool)
            ? tool.descriptor.name==='workspace.npm_build'?'npm-build':'npm-test':'node-check';
          if (result?.recipeId!==recipeId || !Number.isSafeInteger(result.exitCode)) throw Error('命令结果无效');
          return {recipeId,exitCode:result.exitCode,passed:result.exitCode===0};
        }
        if (Buffer.byteLength(JSON.stringify(result),'utf8')>coding.MAX_SERIALIZED_WORKSPACE_TOOL_RESULT_BYTES) throw Error('工具结果超过传输上限，请缩小范围');
        return structuredClone(result);
      }})),
    close(){active=false;revoke();applyHost?.close();},
  };
}
