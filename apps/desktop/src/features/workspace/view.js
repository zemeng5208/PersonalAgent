import {Orb} from '../orb/orb.js';
import {stateNames, isTerminal} from '../conversation/state.js';
import {readProfile} from '../admin/profile.js';

const paths = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  new: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M15 3l6 6M8 16l1-5L18 2l4 4-9 9-5 1z"/>',
  git: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12m0-8c4 0 4-2 10-2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plugin: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/>',
  shield: '<path d="m12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6l8-3z"/><path d="m8 12 3 3 5-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3V7z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0m-7 7v3"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  minimize: '<path d="M5 12h14"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;

export function mountWorkspace(root, invoke, escape) {
  let current = {tasks: []}, selected = null, pending = false, draftInitialized = false, lastSignature = '';
  root.innerHTML = `<section class="workspace"><header class="workspace-titlebar"><button class="icon-btn" id="workspace-sidebar-toggle" aria-label="切换侧边栏" aria-expanded="true">${icon('sidebar')}</button><span class="workspace-app-title">PersonalAgent</span><span class="spacer"></span><button class="window-button" data-window="minimize" aria-label="最小化">${icon('minimize')}</button><button class="window-button" data-window="maximize" aria-label="最大化或还原">${icon('maximize')}</button><button class="window-button window-close" data-window="close" aria-label="关闭工作区">${icon('close')}</button></header><aside class="workspace-sidebar"><div class="workspace-brand"><strong>PersonalAgent</strong><span class="spacer"></span><button class="icon-btn" id="workspace-search-toggle" aria-label="搜索任务">${icon('search')}</button><button class="icon-btn" id="workspace-notices" aria-label="通知">${icon('bell')}</button></div><input id="workspace-search" type="search" placeholder="搜索任务" aria-label="搜索任务" hidden><nav class="workspace-nav" aria-label="工作区导航"><button id="workspace-new">${icon('new')}新对话</button>${[['git','git','Pull Request'],['clock','tasks','已安排'],['plugin','capabilities','插件'],['shield','authorizations','安全'],['more','connections','探索']].map(([symbol,page,title])=>`<button data-open-settings="${page}">${icon(symbol)}${title}</button>`).join('')}</nav><div class="workspace-projects"><h2>项目</h2><button class="workspace-project" id="workspace-project">${icon('folder')}<span>PersonalAgent</span></button><div id="workspace-task-list"></div><p class="workspace-empty-list" id="workspace-empty-list">在这里开始你的第一个任务</p></div><button class="workspace-account" data-open-settings="profile"><span class="workspace-avatar">P</span><span id="workspace-user">个人资料</span><span class="spacer"></span><span aria-hidden="true">⚙</span></button></aside><main class="workspace-main"><div class="workspace-top"><span id="workspace-task-title"></span><span class="spacer"></span><button class="icon-btn" data-open-settings="settings" aria-label="打开设置">${icon('more')}</button></div><div class="workspace-stage" id="workspace-stage"><div class="workspace-welcome" id="workspace-welcome"><button class="workspace-orb" id="workspace-orb" aria-label="点亮悬浮球" aria-pressed="false"><canvas aria-hidden="true"></canvas></button><h1>你想让我们在 <span>PersonalAgent</span> 中构建什么？</h1></div><div class="workspace-conversation" id="workspace-conversation" aria-live="polite" hidden></div></div><div class="workspace-compose-area"><p class="workspace-notice" id="workspace-notice" role="status"></p><div class="workspace-context">${icon('folder')}<span>PersonalAgent</span><span class="context-divider"></span><span>本地</span><span class="context-divider"></span><span id="workspace-runtime">正在连接…</span></div><form class="composer workspace-composer" id="workspace-form"><textarea id="workspace-input" aria-label="任务内容" placeholder="随心输入" maxlength="10000"></textarea><div class="composer-bar"><button class="icon-btn" type="button" disabled title="附件功能尚未接入" aria-label="添加附件">${icon('plus')}</button><button class="workspace-approval" type="button" data-open-settings="authorizations">${icon('shield')}请求批准</button><span class="spacer"></span><button class="workspace-model" type="button" data-open-settings="models"><span id="workspace-model-name">模型</span>${icon('down')}</button><button class="icon-btn" type="button" disabled title="语音尚未连接" aria-label="语音输入">${icon('mic')}</button><button class="send-btn" id="workspace-send" type="submit" aria-label="发送消息">${icon('send')}</button></div></form><p class="workspace-error" id="workspace-error" role="alert"></p></div></main></section>`;
  const input = root.querySelector('#workspace-input');
  const taskList = root.querySelector('#workspace-task-list');
  const search = root.querySelector('#workspace-search');
  const orbButton = root.querySelector('#workspace-orb');
  const orb = new Orb(orbButton.querySelector('canvas'), {variant:'matrix',layout:'shell',count:170});
  orb.setBreathing({min:.52,max:.76,rate:.7});
  const syncMotion = () => orb.setCalm(document.documentElement.dataset.calm === 'true');
  syncMotion(); window.addEventListener('preferences-changed', syncMotion);
  const visibility = () => { if(document.hidden) orb.stop(); else syncMotion(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('unload', () => { orb.dispose(); window.removeEventListener('preferences-changed',syncMotion); document.removeEventListener('visibilitychange',visibility); });
  const report = error => { root.querySelector('#workspace-error').textContent = error.message || String(error); };
  orbButton.onclick = () => { const active = orbButton.getAttribute('aria-pressed') !== 'true'; orbButton.setAttribute('aria-pressed',String(active)); orb.setCohesion(active ? .85 : null); };
  root.querySelectorAll('[data-window]').forEach(button=>button.onclick=()=>invoke(`workspace.${button.dataset.window}`).catch(report));
  root.querySelectorAll('[data-open-settings]').forEach(button=>button.onclick=()=>invoke('admin.open',{page:button.dataset.openSettings}).catch(report));
  root.querySelector('#workspace-sidebar-toggle').onclick = event => { const collapsed = root.querySelector('.workspace').classList.toggle('sidebar-collapsed'); event.currentTarget.setAttribute('aria-expanded',String(!collapsed)); };
  root.querySelector('#workspace-search-toggle').onclick = () => { search.hidden = !search.hidden; if(!search.hidden) search.focus(); else { search.value=''; update(current); } };
  root.querySelector('#workspace-notices').onclick = () => { root.querySelector('#workspace-notice').textContent = current.approvals?.length ? `有 ${current.approvals.length} 项授权等待处理` : '暂无新通知'; };
  const newChat = () => { selected=null; input.value=''; void invoke('workspace.draft','').catch(report); update(current); input.focus(); };
  root.querySelector('#workspace-new').onclick = newChat;
  root.querySelector('#workspace-project').onclick = () => { selected=null; update(current); };
  taskList.onclick = event => { const button=event.target.closest('[data-task]'); if(button){selected=button.dataset.task;update(current);} };
  search.oninput = () => update(current);
  input.oninput = () => { root.querySelector('#workspace-send').disabled=pending || !input.value.trim(); void invoke('workspace.draft',input.value).catch(report); };
  input.onkeydown = event => { if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(input.value.trim()&&!pending)root.querySelector('#workspace-form').requestSubmit();} };
  root.querySelector('#workspace-form').onsubmit = async event => {
    event.preventDefault(); if(pending||!input.value.trim()) return;
    pending=true;root.querySelector('#workspace-send').disabled=true;
    try {
      const task=await invoke('task.submit',input.value);
      selected=task.taskId;input.value='';await invoke('workspace.draft','');
      root.querySelector('#workspace-error').textContent='';
      update(await invoke('snapshot'));
    } catch(error){report(error);} finally {pending=false;root.querySelector('#workspace-send').disabled=!input.value.trim();}
  };
  root.querySelector('#workspace-conversation').onclick = async event => {
    const button=event.target.closest('[data-cancel]'); if(!button) return;
    button.disabled=true;
    try{await invoke('task.cancel',button.dataset.cancel);}catch(error){report(error);button.disabled=false;}
  };

  function update(data) {
    current=data;
    if(!draftInitialized){input.value=data.workspaceDraft || '';draftInitialized=true;}
    root.querySelector('#workspace-send').disabled=pending||!input.value.trim();
    root.querySelector('#workspace-user').textContent=readProfile().name;
    root.querySelector('#workspace-runtime').textContent=data.fake ? '离线联调' : '本地工作区';
    root.querySelector('#workspace-model-name').textContent=data.model?.configured ? data.model.model : '配置模型';
    const matching=(data.tasks||[]).filter(task=>`${task.userMessage || ''} ${task.taskId}`.toLowerCase().includes(search.value.toLowerCase()));
    taskList.innerHTML=matching.slice().reverse().map(task=>`<button class="workspace-task" data-task="${escape(task.taskId)}" aria-current="${selected===task.taskId?'page':'false'}" title="${escape(task.userMessage||task.taskId)}"><span>${escape(task.userMessage||task.taskId)}</span><span class="workspace-task-state">${escape(stateNames[task.state]||task.state)}</span></button>`).join('');
    root.querySelector('#workspace-empty-list').hidden=matching.length>0;
    root.querySelector('#workspace-empty-list').textContent=search.value?'没有匹配的任务':'在这里开始你的第一个任务';
    const task=data.tasks?.find(item=>item.taskId===selected);
    root.querySelector('#workspace-task-title').textContent=task?.userMessage || '';
    root.querySelector('#workspace-welcome').hidden=Boolean(task);
    const conversation=root.querySelector('#workspace-conversation');conversation.hidden=!task;
    if(task){
      const signature=JSON.stringify(task);
      if(signature!==lastSignature){
        lastSignature=signature;
        const result=(task.resultSummary||'').replace(/\s*\[model=[^;\]]+;\s*verification=[^;\]]+;\s*tokens=\d+\]\s*$/,'').trim();
        conversation.innerHTML=`<article class="workspace-turn"><div class="user-message">${escape(task.userMessage || '任务')}</div><div class="assistant-message">${escape(result || task.error?.message || stateNames[task.state] || task.state)}</div>${!isTerminal(task)?`<button class="btn btn-sm" data-cancel="${escape(task.taskId)}" ${task.state==='cancelling'?'disabled':''}>${task.state==='cancelling'?'正在停止':'停止任务'}</button>`:''}</article>`;
      }
    } else lastSignature='';
  }
  return update;
}
