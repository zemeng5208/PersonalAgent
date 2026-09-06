import {Orb} from '../features/orb/orb.js';
import {orbState,stateNames,isTerminal} from '../features/conversation/state.js';
import {mountAdmin} from '../features/admin/view.js';
const root = document.querySelector('#root');
const mode = new URLSearchParams(location.search).get('mode');
const bridge = window.desktop;
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function invoke(action,payload) {
  if(!bridge) throw Error('桌面桥未连接，请从 PersonalAgent 桌面应用启动');
  const response=await bridge.invoke(action,payload); if(!response.ok) throw Error(response.error); return response.value;
}
let render, orb;
if(mode==='orb') {
  root.innerHTML='<button class="orb-button" aria-label="打开 PersonalAgent"><canvas aria-hidden="true"></canvas></button>';
  orb=new Orb(root.querySelector('canvas'),{variant:'matrix',layout:'shell',count:170});
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'); orb.setCalm(reduced.matches);
  reduced.addEventListener('change',e=>orb.setCalm(e.matches));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)orb.stop();else orb.setCalm(reduced.matches);});
  let start,drag=false;
  const button=root.querySelector('button');
  button.addEventListener('pointerdown',e=>{if(e.button!==0)return;start={x:e.screenX,y:e.screenY};button.setPointerCapture(e.pointerId);});
  button.addEventListener('pointermove',e=>{if(start&&!drag&&Math.hypot(e.screenX-start.x,e.screenY-start.y)>4){drag=true;invoke('orb.dragStart');}});
  function finish(){if(drag)invoke('orb.dragEnd');else if(start)invoke('orb.open');start=null;drag=false;}
  button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',()=>{if(drag)invoke('orb.dragEnd');start=null;drag=false;});
  button.addEventListener('lostpointercapture',()=>{if(drag)invoke('orb.dragEnd');start=null;drag=false;});
  button.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();invoke('orb.open');}});
  render=data=>{orb.setLevel(data.audioLevel??0);orb.setState(data.orbStateOverride??orbState(data.tasks.at(-1)));button.setAttribute('aria-label',`PersonalAgent · ${stateNames[data.tasks.at(-1)?.state]??'待机'}`);};
} else if(mode==='admin') render=mountAdmin(root,invoke,escape);
else {
  root.innerHTML=`<section class="panel"><header><span class="dot"></span><strong>PersonalAgent</strong><span class="status" id="state">待机</span><span class="spacer"></span><button class="icon-btn hdr-btn" id="admin" title="设置" aria-label="设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button><span class="bell-box"><button class="icon-btn hdr-btn" id="bell" title="通知" aria-label="通知" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></button><span class="bell-menu" id="bell-menu" role="menu" hidden><div class="notice">无新通知。通知能力尚未连接。</div></span></span><button class="icon-btn hdr-btn" id="close" title="收起面板" aria-label="收起面板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></header><div class="thread"><div class="who" id="connection"></div><div class="bubble">有什么可以帮你？</div><div class="notice">盘古与语音尚未连接。连接能力后即可开始协作。</div><div id="tasks"></div><p class="error" role="alert" id="error"></p></div><form class="composer"><textarea aria-label="任务内容" placeholder="说要做什么…" maxlength="10000"></textarea><div class="composer-bar"><button class="icon-btn" type="button" id="stop" disabled title="停止播报" aria-label="停止播报"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="m16 9.5 5 5"/><path d="m21 9.5-5 5"/></svg></button><span class="spacer"></span><span class="model-box"><button class="model-select" type="button" id="model" aria-haspopup="true" aria-expanded="false" title="模型与思考深度"><span>盘古大模型 2.0</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><span class="model-menu" id="model-menu" role="menu" hidden><span class="mm-card"><span class="mm-top"><button class="icon-btn mm-fast" type="button" id="mm-fast" title="快速模式" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg></button><span class="mm-depth"><span id="mm-depth-label">低</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span><button class="icon-btn" type="button" disabled title="思考设置待 Runtime 支持"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button></span><span class="mm-model">盘古大模型 2.0<span class="model-tag" id="model-tag">未测试</span></span><input class="mm-slider" id="mm-slider" type="range" min="0" max="5" step="1" value="1" aria-label="盘古大模型 2.0 思考深度"></span><span class="notice" id="model-notice">模型未完成真实连接测试；思考参数暂未传入 Runtime。</span></span></span><button class="icon-btn" type="button" id="talk" disabled title="语音转文字未连接" aria-label="语音转文字"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></button><button class="send-btn" id="send" type="submit" data-mode="voice" title="语音模式（语音模型未连接）" aria-label="发送或语音模式"><svg class="icon-voice" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 10.5v3"/><path d="M10.5 8v8"/><path d="M14 9.5v5"/><path d="M17.5 11v2"/></svg><svg class="icon-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg></button></div><div class="notice mic-state">麦克风：未采集</div></form></section>`;
  let current,pending=false;
  const report=e=>root.querySelector('#error').textContent=e.message;
  const sendBtn=root.querySelector('#send'),modelBtn=root.querySelector('#model'),modelMenu=root.querySelector('#model-menu');
  const bellBtn=root.querySelector('#bell'),bellMenu=root.querySelector('#bell-menu');
  const slider=root.querySelector('#mm-slider'),depthLabel=root.querySelector('#mm-depth-label'),fastBtn=root.querySelector('#mm-fast');
  const closeModel=()=>{modelMenu.hidden=true;modelBtn.setAttribute('aria-expanded','false');};
  const closeBell=()=>{bellMenu.hidden=true;bellBtn.setAttribute('aria-expanded','false');};
  const syncSlider=()=>{const v=Number(slider.value);const labels=['最低','低','平衡','深入','高','最高'];const fill=6+(88*v/5);slider.style.setProperty('--fill',fill+'%');depthLabel.textContent=labels[v]??'平衡';modelMenu.classList.toggle('maxed',v===5);};
  const setSendMode=hasText=>{sendBtn.dataset.mode=hasText?'send':'voice';sendBtn.title=hasText?'发送':'语音模式（语音模型未连接）';};
  root.querySelector('#admin').onclick=()=>invoke('admin.open').catch(report);
  root.querySelector('#close').onclick=()=>invoke('panel.hide').catch(report);
  modelBtn.onclick=e=>{e.stopPropagation();const open=modelMenu.hidden;closeModel();closeBell();if(open){modelMenu.hidden=false;modelBtn.setAttribute('aria-expanded','true');}};
  bellBtn.onclick=e=>{e.stopPropagation();const open=bellMenu.hidden;closeBell();closeModel();if(open){bellMenu.hidden=false;bellBtn.setAttribute('aria-expanded','true');}};
  document.addEventListener('click',e=>{if(!modelMenu.hidden&&!e.target.closest('.model-box'))closeModel();if(!bellMenu.hidden&&!e.target.closest('.bell-box'))closeBell();});
  slider.addEventListener('input',()=>{syncSlider();invoke('thinking.update',{depth:Number(slider.value),fast:fastBtn.getAttribute('aria-pressed')==='true'}).catch(report);});syncSlider();
  fastBtn.onclick=()=>{const on=fastBtn.getAttribute('aria-pressed')!=='true';fastBtn.setAttribute('aria-pressed',String(on));modelMenu.classList.toggle('fast',on);invoke('thinking.update',{depth:Number(slider.value),fast:on}).catch(report);};
  root.querySelector('textarea').addEventListener('input',e=>{setSendMode(Boolean(e.target.value.trim()));invoke('panel.pin',true).catch(report);});
  sendBtn.addEventListener('click',()=>{if(sendBtn.dataset.mode==='voice')report('语音模型未连接，圆形按钮预留给语音模式');});
  document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(!modelMenu.hidden){closeModel();return;}if(!bellMenu.hidden){closeBell();return;}invoke('panel.hide').catch(report);});
  root.querySelector('form').onsubmit=async e=>{e.preventDefault();if(pending)return;const input=root.querySelector('textarea');if(!input.value.trim())return;pending=true;sendBtn.disabled=true;try{await invoke('task.submit',input.value);input.value='';setSendMode(false);root.querySelector('#error').textContent='';}catch(err){report(err);}finally{pending=false;sendBtn.disabled=!input.value.trim();}};
  const stopButton=root.querySelector('#stop');
  // voice.stop is deliberately separate from task.cancel. The current build has no
  // voice provider, so it reports unavailable instead of claiming that speech stopped.
  stopButton.onclick=async()=>{window.speechSynthesis?.cancel();try{const result=await invoke('voice.stop');if(!result?.stopped)report(result?.reason??'语音供应商尚未连接');}catch(err){report(err);}};
  root.querySelector('#tasks').onclick=async e=>{const b=e.target.closest('[data-action]');if(!b)return;b.disabled=true;try{await invoke(b.dataset.action,b.dataset.id);}catch(err){report(err);}finally{b.disabled=false;}};
  render=data=>{current=data;const task=data.tasks.at(-1);root.querySelector('#connection').textContent=data.fakeModel?data.connection+' · Fake Model':data.connection;root.querySelector('#state').textContent=task?stateNames[task.state]:'待机';
    root.querySelector('#error').textContent=data.connectionError??'';
    const modelReady=data.model?.status==='ready';
    // Thinking controls are a local test surface.  They must remain draggable
    // even while the provider is unconfigured or its connection test failed;
    // Runtime support is reported separately instead of disabling the control.
    fastBtn.disabled=false;slider.disabled=false;
    modelBtn.title=modelReady?'模型与思考深度':'思考设置可调整；模型尚未完成真实连接测试';
    if(data.thinking){slider.value=String(data.thinking.depth??1);fastBtn.setAttribute('aria-pressed',String(Boolean(data.thinking.fast)));modelMenu.classList.toggle('fast',Boolean(data.thinking.fast));syncSlider();}
    const tag=root.querySelector('#model-tag');if(tag)tag.textContent=modelReady?'已测试':data.model?.status==='configured'?'待测试':'未配置';
    const modelNotice=root.querySelector('#model-notice');if(modelNotice)modelNotice.textContent=modelReady?'思考设置已保存到桌面测试状态；Runtime 参数契约接入后才会影响任务。':`${data.model?.reason??'模型未完成真实连接测试'}；思考设置仍可调整，但不会用于真实任务。`;
    stopButton.disabled=data.voice?.available!==true;stopButton.title=data.voice?.available===true?'停止播报':'停止播报（语音供应商未连接）';
    root.querySelector('#tasks').innerHTML=data.tasks.map(t=>`<article class="task"><h3>${stateNames[t.state]}</h3><div class="notice">${escape(t.taskId)}</div>${t.resultSummary?`<div class="bubble">${escape(t.resultSummary)}</div>`:''}<div class="actions"><button class="btn btn-sm" data-action="task.refresh" data-id="${escape(t.taskId)}">刷新状态</button><button class="btn btn-sm" data-action="task.cancel" data-id="${escape(t.taskId)}" ${isTerminal(t)||t.state==='cancelling'?'disabled':''}>取消任务</button>${data.fake&&!isTerminal(t)?`<button class="btn btn-sm" data-action="test.advance" data-id="${escape(t.taskId)}">推进联调一步</button>`:''}</div></article>`).join('');};
}
if(bridge){const unsubscribe=bridge.subscribe(render);invoke('snapshot').then(render).catch(e=>{root.textContent=e.message;});window.addEventListener('unload',()=>{unsubscribe();orb?.dispose();});}
else root.textContent='桌面桥未连接，请从 PersonalAgent 桌面应用启动。';
