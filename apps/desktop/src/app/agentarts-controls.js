export function mountAgentArtsControls(root,invoke) {
  const section=document.createElement('section');section.className='sheet coding-workspace';
  section.innerHTML='<h2>AgentArts 主智能体</h2><form class="settings-form"><label>网关地址<input name="gatewayUrl" type="url" autocomplete="off" placeholder="https://…huaweicloud-agentarts.com" required></label><label>运行时实例名称<input name="runtimeName" autocomplete="off" required></label><label>Authorization<input name="authorization" type="password" autocomplete="off" placeholder="控制台 API 示例中的完整值；留空沿用同一实例凭据"></label><p class="notice">凭据只在本机加密保存，不进入模型提示或聊天。更换运行时后需要重启应用。</p><div class="btn-group" style="display:flex;gap:8px;"><button type="submit" class="btn">保存 AgentArts 配置</button><button type="button" data-revoke class="btn btn-secondary">清除并撤销凭据</button></div><p data-status class="notice" role="status"></p></form>';
  root.append(section);const form=section.querySelector('form'),status=section.querySelector('[data-status]'),revokeBtn=section.querySelector('[data-revoke]');let dirty=false;
  form.addEventListener('input',()=>{dirty=true;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;
    const input=Object.fromEntries(['gatewayUrl','runtimeName','authorization'].map(key=>[key,form.elements[key].value.trim()]));
    form.elements.authorization.value='';
    try {const result=await invoke('agentarts.configure',input);dirty=false;status.textContent=result?.reason || '配置已保存。';}
    catch {status.textContent='配置未保存，请核对网关、运行时名称和 Authorization。';}
    finally {input.authorization='';button.disabled=false;}
  });
  revokeBtn?.addEventListener('click',async()=>{
    revokeBtn.disabled=true;
    try {const result=await invoke('agentarts.revoke');dirty=false;form.reset();status.textContent=result?.reason || '凭据已清除。';}
    catch {status.textContent='撤销失败，请确保当前没有进行中的任务或通话。';}
    finally {revokeBtn.disabled=false;}
  });
  return {show:value=>{section.hidden=!value;},render(value={}){
    if (!dirty) {form.elements.gatewayUrl.value=value.gatewayUrl??'';form.elements.runtimeName.value=value.runtimeName??'';}
    if (!status.textContent) status.textContent=value.reason??'';
  }};
}
