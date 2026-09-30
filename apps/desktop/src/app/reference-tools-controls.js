export function mountReferenceToolsControls(root,invoke) {
  const host=document.createElement('section');host.className='sheet reference-tools-settings';
  host.innerHTML='<h2>工作区参考工具</h2><p class="muted">使用已许可的工作区读取参考文件。每次读取仍需任务授权。</p><p data-reference-state></p><div class="setting-row"><button class="btn" data-reference="mcp">连接只读服务</button><button class="btn" data-reference="skill">启用参考摘要</button></div><label>参考文件的相对路径<input class="field" data-reference-path placeholder="docs/reference.md" autocomplete="off"></label><button class="btn" data-reference="run">生成参考摘要</button><p class="notice" role="status" data-reference-result></p>';
  root.append(host);let state;
  const result=host.querySelector('[data-reference-result]');
  host.addEventListener('click',async event=>{
    const button=event.target.closest('[data-reference]');if(!button)return;
    button.disabled=true;result.textContent='';
    try {
      const action=button.dataset.reference;
      const value=await invoke('reference.'+action,action==='run'?{path:host.querySelector('[data-reference-path]').value}
        :{enabled:action==='mcp'?!state?.mcp?.connected:!state?.skill?.health?.enabled});
      if(action==='run')result.textContent='已创建任务 '+value.taskId+'；授权与结果可在任务和安全页面查看。';
    } catch {result.textContent='操作未完成，请检查工作区许可、服务状态及任务授权。';}
    finally {button.disabled=false;}
  });
  return {show:visible=>{host.hidden=!visible;},render(value){state=value;
    host.querySelector('[data-reference-state]').textContent='只读服务：'+(value?.mcp?.state??'unavailable')+'；参考摘要：'+(value?.skill?.health?.state??'unavailable');
    host.querySelector('[data-reference="mcp"]').textContent=value?.mcp?.connected?'停止只读服务':'连接只读服务';
    host.querySelector('[data-reference="skill"]').textContent=value?.skill?.health?.enabled?'停用参考摘要':'启用参考摘要';
    host.querySelector('[data-reference="run"]').disabled=value?.skill?.health?.state!=='ready';
  }};
}
