import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

/** Discover only this checkout and its Git common root; never download weights. */
export function discoverLocalLaya(projectRoot) {
  const roots = [path.resolve(projectRoot)];
  try {
    const gitFile = path.join(projectRoot, '.git');
    if (statSync(gitFile).isFile()) {
      const match = /^gitdir: (.+)\s*$/m.exec(readFileSync(gitFile, 'utf8'));
      if (match) {
        const gitDir = path.resolve(projectRoot, match[1].trim());
        const commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        if (path.basename(commonDir) === '.git') roots.push(path.dirname(commonDir));
      }
    }
  } catch { /* A distribution may not have Git metadata. */ }
  const script = path.join(projectRoot, 'scripts/laya/batch-server.py');
  if (!existsSync(script)) return;
  for (const root of roots) {
    const cache = path.join(root, '.cache/laya');
    const python = path.join(cache, 'venv/Scripts/python.exe');
    const snapshots = path.join(cache, 'hf/hub/models--convaiinnovations--laya/snapshots');
    if (!existsSync(python) || !existsSync(snapshots)) continue;
    for (const entry of readdirSync(snapshots, {withFileTypes:true}).filter(entry => entry.isDirectory())) {
      const model = path.join(snapshots, entry.name, 'multilingual');
      const weights = path.join(model, 'model.safetensors');
      if (!existsSync(weights)) continue;
      const relative = path.relative(realpathSync(cache), realpathSync(weights));
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      return {python, model, script};
    }
  }
}

/** One explicitly started, owned child. No microphone, cloud call or background restart. */
export function createLocalLayaHost({projectRoot, createService, onUpdate = () => {}, port = 8766,
  discover = discoverLocalLaya, launch = spawn, request = fetch, freeMemory = os.freemem,
  startupTimeoutMs = 90_000, now = Date.now, sleep = delay}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid Laya loopback port');
  let child, service, controller, starting, stopping;
  let state = 'stopped', reason = '本地分类尚未启动；启动时才加载现有模型';
  const snapshot = () => ({state, ready:state === 'ready', reason, localOnly:true, calibrated:false});
  const publish = () => {try {onUpdate();} catch {}};
  const stop = async () => {
    if (stopping) return stopping;
    controller?.abort(); service = undefined;
    const owned = child;
    state = owned ? 'stopping' : 'stopped'; reason = owned ? '正在释放本地模型' : '本地模型已停止'; publish();
    if (!owned) return snapshot();
    stopping = (async () => {
      owned.kill();
      const end = now() + 3000;
      while (child === owned && now() < end) await sleep(50);
      if (child === owned) {state = 'stop_unconfirmed'; reason = '模型进程退出尚未确认，请稍后再试';}
      else {state = 'stopped'; reason = '本地模型已停止';}
      publish(); return snapshot();
    })().finally(() => {stopping = undefined;});
    return stopping;
  };
  async function start() {
    if (starting) return starting;
    if (state === 'ready') return snapshot();
    if (child || stopping) throw Error('本地模型尚未停止');
    const config = discover(projectRoot);
    if (!config) {state = 'unavailable'; reason = '未找到项目内已安装的 Laya 和模型；不会自动下载'; publish(); return snapshot();}
    if (freeMemory() < 3 * 1024 ** 3) {
      state = 'memory_insufficient'; reason = '当前可用内存不足 3 GB，暂不加载本地模型；其他功能可继续使用'; publish(); return snapshot();
    }
    controller = new AbortController();
    const signal = controller.signal, key = randomBytes(32).toString('hex');
    state = 'starting'; reason = '正在加载本地模型'; publish();
    starting = (async () => {
      try {
        const env = Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']
          .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
        const owned = launch(config.python, [config.script], {cwd:projectRoot, windowsHide:true, shell:false,
          stdio:'ignore', env:{...env, LAYA_MODEL_PATH:config.model, LAYA_API_KEY:key, LAYA_PORT:String(port),
            HF_HUB_OFFLINE:'1', TRANSFORMERS_OFFLINE:'1', PYTHONNOUSERSITE:'1'}});
        child = owned;
        const exited = () => {
          if (child !== owned) return;
          child = undefined; service = undefined;
          if (!signal.aborted) {controller.abort(); state = 'error'; reason = '本地模型进程已退出，请检查安装后重新启动'; publish();}
        };
        owned.once('exit', exited); owned.once('error', exited);
        const end = now() + startupTimeoutMs;
        while (!signal.aborted && child === owned && now() < end) {
          try {
            const response = await request(`http://127.0.0.1:${port}/health`, {redirect:'error',
              headers:{authorization:`Bearer ${key}`}, signal:AbortSignal.any([signal, AbortSignal.timeout(1500)])});
            if (response.ok) {
              const value = await response.json();
              if (value.status === 'ok' && value.model === 'multilingual'
                && value.capabilities?.includes('multi_state') && value.maxStates === 4 && !signal.aborted && child === owned) {
                service = createService({port, getApiKey:() => key});
                state = 'ready'; reason = '本机 Laya 已连接；批量分类结果仍需结合来源核对'; publish(); return snapshot();
              }
            } else await response.body?.cancel();
          } catch {if (signal.aborted) break;}
          await sleep(300);
        }
        if (!signal.aborted) throw Error('startup timeout');
      } catch {
        await stop();
        if (state !== 'stop_unconfirmed') {state = 'error'; reason = '本地模型启动未成功，不会切换到云端分类'; publish();}
      }
      return snapshot();
    })().finally(() => {starting = undefined;});
    return starting;
  }
  return {snapshot, start, stop,
    async classify(input) {
      if (!service || state !== 'ready' || controller.signal.aborted) throw Error('本地 Laya 尚未就绪');
      return service.classify({...input, signal:AbortSignal.any([input.signal, controller.signal])});
    },
  };
}
