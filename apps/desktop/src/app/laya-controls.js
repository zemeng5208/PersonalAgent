export function mountLayaControls(root, invoke) {
  const element = document.createElement('section');
  element.className = 'sheet';
  element.innerHTML = '<h2>本地 Laya</h2><p>用于邮件分类和候选判断。手动启动后在本机处理，关闭即释放模型。</p><button class="btn" data-laya="start">启动本地模型</button> <button class="btn" data-laya="stop">停止并释放</button><p data-laya="status" role="status"></p>';
  root.querySelector('#error').before(element);
  let state = {}, busy = false;
  const field = name => element.querySelector(`[data-laya="${name}"]`);
  function render(value = {}) {
    state = value; field('status').textContent = value.reason || '本地模型尚未装配';
    field('start').disabled = busy || ['ready','starting','stopping','stop_unconfirmed'].includes(value.state);
    field('stop').disabled = !['ready','starting','stop_unconfirmed'].includes(value.state);
  }
  async function run(action) {
    let failure = '';
    busy = true; render(state);
    try {render(await invoke(`laya.${action}`));}
    catch {failure = '本地模型操作未完成，请查看当前状态';}
    finally {busy = false; render(state); if (failure) field('status').textContent = failure;}
  }
  field('start').onclick = () => run('start'); field('stop').onclick = () => run('stop');
  return {render, show:visible => {element.hidden = !visible;}};
}
