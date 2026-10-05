export function mountAgentArtsControls(root,invoke) {
  const section=document.createElement('section');section.className='sheet coding-workspace';
  section.innerHTML='<h2>AgentArts 主智能体</h2><form class="settings-form"><label>网关地址<input name="gatewayUrl" type="url" autocomplete="off" placeholder="https://…huaweicloud-agentarts.com" required></label><label>运行时实例名称<input name="runtimeName" autocomplete="off" required></label><label>Authorization<input name="authorization" type="password" autocomplete="off" placeholder="控制台 API 示例中的完整值；留空沿用同一实例凭据"></label><p class="notice">凭据只在本机加密保存，不进入模型提示或聊天。更换运行时后需要重启应用。</p><div class="btn-group"><button type="submit" class="btn btn-primary">保存 AgentArts 配置</button><button type="button" data-revoke class="btn btn-secondary btn-danger">清除并撤销凭据</button></div><p data-status class="notice" role="status"></p></form>';
  root.append(section);const form=section.querySelector('form'),status=section.querySelector('[data-status]'),revokeBtn=section.querySelector('[data-revoke]');let dirty=false,busy=false,feedbackKind='host',lastHostReason='';
  function setBusy(value) {
    busy=value;form.setAttribute('aria-busy',String(value));
    form.querySelectorAll('input,button').forEach(control=>{control.disabled=value;});
  }
  function feedback(message,error=false) {feedbackKind=error?'unconfirmed':'operation';status.textContent=message;status.setAttribute('role',error?'alert':'status');}
  form.addEventListener('input',()=>{dirty=true;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if (busy) return;setBusy(true);feedback('正在保存配置…');
    const input=Object.fromEntries(['gatewayUrl','runtimeName','authorization'].map(key=>[key,form.elements[key].value.trim()]));
    form.elements.authorization.value='';
    try {const result=await invoke('agentarts.configure',input);if (result?.configured!==true) throw Error();dirty=false;feedback(result.reason || '配置已保存。');}
    catch {feedback('保存结果未获确认，请检查配置状态后再操作。',true);}
    finally {input.authorization='';setBusy(false);}
  });
  revokeBtn?.addEventListener('click',async()=>{
    if (busy) return;setBusy(true);feedback('正在撤销凭据…');form.elements.authorization.value='';
    try {const result=await invoke('agentarts.revoke');if (result?.configured!==false) throw Error();dirty=false;form.reset();feedback(result.reason || '凭据已清除。');}
    catch {feedback('撤销结果未获确认，请检查配置状态和本机存储后重试。',true);}
    finally {setBusy(false);}
  });
  return {show:value=>{section.hidden=!value;},render(value={}){
    if (!dirty && !busy) {form.elements.gatewayUrl.value=value.gatewayUrl??'';form.elements.runtimeName.value=value.runtimeName??'';}
    const reason=typeof value.reason==='string'?value.reason:'';
    if (!busy && feedbackKind!=='unconfirmed' && (feedbackKind==='host' || reason!==lastHostReason)) {
      status.textContent=reason;status.setAttribute('role','status');feedbackKind='host';
    }
    lastHostReason=reason;
  }};
}
