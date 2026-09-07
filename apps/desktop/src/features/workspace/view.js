import {Orb} from '../orb/orb.js';
import {stateNames,isTerminal} from '../conversation/state.js';
import {mountConversationRail} from '../conversation/rail.js';
import {connectorCards} from './connectors.js';

const paths={settings:'M4 7h10m4 0h2M4 17h2m4 0h10M16 4v6M8 14v6',connectors:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zm11 3h7m-3-3v7',close:'m6 6 12 12M6 18 18 6',maximize:'M5 5h14v14H5z',minimize:'M5 12h14',copy:'M8 8h12v12H8zM16 8V4H4v12h4',view:'M3 5h18v14H3zM9 5v14'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
const resultText=value=>String(value||'').replace(/\s*\[model=[^;\]]+;\s*verification=[^;\]]+;\s*tokens=[^\]]+\]\s*$/,'').trim();

export function mountWorkspace(root,invoke,escape){
  let current={tasks:[]},lastSignature='',cardsSignature='',inspected=null;
  root.innerHTML=`<section class="workspace focused-workspace">
    <header class="workspace-titlebar"><span class="workspace-app-title">PersonalAgent</span><span class="spacer"></span><button class="window-button" data-window="minimize" aria-label="最小化">${icon('minimize')}</button><button class="window-button" data-window="maximize" aria-label="最大化或还原">${icon('maximize')}</button><button class="window-button window-close" data-window="close" aria-label="关闭工作区">${icon('close')}</button></header>
    <main class="workspace-main"><header class="workspace-top"><strong>悬浮球对话</strong><span class="spacer"></span><button class="icon-btn" id="connectors-toggle" aria-label="显示或隐藏连接器" aria-expanded="true">${icon('connectors')}</button><button class="icon-btn" data-open-settings="settings" aria-label="打开设置">${icon('settings')}</button></header>
    <div class="workspace-layout"><section class="workspace-chat"><p class="workspace-error" id="workspace-error" role="alert"></p><div class="workspace-stage" id="workspace-stage"><div class="workspace-welcome" id="workspace-welcome"><button class="workspace-orb" id="workspace-orb" aria-label="激活粒子扩散" aria-pressed="false"><canvas aria-hidden="true"></canvas></button><h1 id="workspace-greeting">从一个想法开始</h1><p id="workspace-intro">在这里查看对话与连接器信息。</p></div><div class="workspace-conversation" id="workspace-conversation" aria-live="polite"></div></div></section>
      <aside class="connector-board" aria-label="连接器信息"><header><div><h2>连接器</h2><p>你的信息，一处查看</p></div><button class="icon-btn" id="connectors-refresh" aria-label="刷新连接器">↻</button></header><div id="connector-cards"></div></aside>
      <aside class="conversation-inspector" id="conversation-inspector" aria-label="对话内部查看" hidden><header><h2>对话详情</h2><button class="icon-btn" id="inspector-close" aria-label="关闭对话详情">${icon('close')}</button></header><div id="inspector-content"></div></aside></div>
    </main></section>`;
  const conversation=root.querySelector('#workspace-conversation'),stage=root.querySelector('#workspace-stage');
  const updateRail=mountConversationRail(root.querySelector('.workspace-chat'),stage);
  const orbButton=root.querySelector('#workspace-orb');
  const orb=new Orb(orbButton.querySelector('canvas'),{variant:'matrix',layout:'shell',count:170});
  orb.setBreathing({min:.52,max:.76,rate:.7});
  const syncMotion=()=>orb.setCalm(document.documentElement.dataset.calm==='true');syncMotion();window.addEventListener('preferences-changed',syncMotion);
  const visibility=()=>{if(document.hidden)orb.stop();else syncMotion();};document.addEventListener('visibilitychange',visibility);
  let activationTimer;
  window.addEventListener('unload',()=>{clearTimeout(activationTimer);orb.dispose();window.removeEventListener('preferences-changed',syncMotion);document.removeEventListener('visibilitychange',visibility);});
  orbButton.onclick=()=>{
    clearTimeout(activationTimer);orbButton.setAttribute('aria-pressed','true');orbButton.classList.remove('orb-burst');void orbButton.offsetWidth;orbButton.classList.add('orb-burst');orb.setCohesion(0);orb.setLevel(1);
    activationTimer=setTimeout(()=>{orbButton.setAttribute('aria-pressed','false');orbButton.classList.remove('orb-burst');orb.setCohesion(null);orb.setLevel(0);},1800);
  };
  const report=error=>{root.querySelector('#workspace-error').textContent=error.message||String(error);};
  root.querySelectorAll('[data-window]').forEach(button=>button.onclick=()=>invoke(`workspace.${button.dataset.window}`).catch(report));
  root.querySelectorAll('[data-open-settings]').forEach(button=>button.onclick=()=>invoke('admin.open',{page:button.dataset.openSettings}).catch(report));
  root.querySelector('#connectors-toggle').onclick=event=>{const hidden=root.querySelector('.connector-board').hidden;root.querySelector('.connector-board').hidden=!hidden;event.currentTarget.setAttribute('aria-expanded',String(hidden));};
  root.querySelector('#connectors-refresh').onclick=async event=>{event.currentTarget.disabled=true;try{await invoke('capability.list');update(await invoke('snapshot'));}catch(error){report(error);}finally{root.querySelector('#connectors-refresh').disabled=false;}};
  root.querySelector('#inspector-close').onclick=()=>{inspected=null;root.querySelector('#conversation-inspector').hidden=true;};
  conversation.onclick=async event=>{
    const button=event.target.closest('[data-cancel],[data-view],[data-copy]');if(!button)return;
    try{if(button.dataset.view){inspected=button.dataset.view;renderInspector();}else if(button.dataset.copy){await invoke('clipboard.writeText',resultText(current.tasks.find(task=>task.taskId===button.dataset.copy)?.resultSummary));button.title='已复制';}else{button.disabled=true;await invoke('task.cancel',button.dataset.cancel);}}catch(error){report(error);button.disabled=false;}
  };
  function renderInspector(){
    const task=current.tasks.find(item=>item.taskId===inspected);if(!task)return;
    root.querySelector('#conversation-inspector').hidden=false;
    root.querySelector('#inspector-content').innerHTML=`<h3>你的消息</h3><p>${escape(task.userMessage||'历史对话')}</p><h3>回答</h3><p>${escape(resultText(task.resultSummary)||task.error?.message||stateNames[task.state])}</p><h3>执行状态</h3><p>${escape(stateNames[task.state]||task.state)}</p>${(task.steps||[]).map(step=>`<p class="inspector-step">${escape(step.label)} · ${escape(step.state)}</p>`).join('')}`;
  }
  function update(data){
    current=data;current.tasks ||= [];
    root.querySelector('#workspace-greeting').hidden=current.tasks.length>0;root.querySelector('#workspace-intro').hidden=current.tasks.length>0;root.querySelector('#workspace-welcome').classList.toggle('compact',current.tasks.length>0);
    const signature=JSON.stringify(data.tasks);
    if(signature!==lastSignature){
      const atBottom=stage.scrollHeight-stage.scrollTop-stage.clientHeight<90;lastSignature=signature;
      conversation.innerHTML=data.tasks.map(task=>`<article class="workspace-turn" data-turn="${escape(task.taskId)}"><div class="user-message">${escape(task.userMessage||'历史对话')}</div><div class="assistant-message">${escape(resultText(task.resultSummary)||task.error?.message||stateNames[task.state]||task.state)}</div><div class="response-actions"><button type="button" data-view="${escape(task.taskId)}" title="在对话内查看" aria-label="查看这轮对话">${icon('view')}</button>${task.resultSummary?`<button type="button" data-copy="${escape(task.taskId)}" title="复制回答" aria-label="复制回答">${icon('copy')}</button>`:''}${!isTerminal(task)?`<button class="turn-action" data-cancel="${escape(task.taskId)}" ${task.state==='cancelling'?'disabled':''}>${task.state==='cancelling'?'正在停止':'停止'}</button>`:''}</div></article>`).join('');
      requestAnimationFrame(()=>{if(atBottom)stage.scrollTop=stage.scrollHeight;updateRail();});if(inspected)renderInspector();
    }
    const nextCards=JSON.stringify([data.capabilities,data.health,data.notifications]);if(cardsSignature!==nextCards){cardsSignature=nextCards;root.querySelector('#connector-cards').innerHTML=connectorCards(data,escape);}
  }
  return update;
}
