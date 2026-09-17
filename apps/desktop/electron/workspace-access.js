import {realpathSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {
  createWorkspaceListTool,
  createWorkspacePatchPreviewTool,
  createWorkspaceReadTool,
} from '@personal-agent/coding-tools';

const defaultToolFactories = Object.freeze([
  createWorkspaceReadTool,
  createWorkspaceListTool,
  createWorkspacePatchPreviewTool,
]);

const samePath = (left, right) => process.platform === 'win32'
  ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
  : left === right;

const inside = (root, candidate) => {
  const relation = path.relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
};

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('未选择有效的工作区目录');
  let resolved;
  try {
    resolved = realpathSync.native(value);
    if (!statSync(resolved).isDirectory()) throw Error('not a directory');
  } catch {
    throw Error('所选工作区目录不存在或不可访问');
  }
  return resolved;
}

function defaultProtectedRoots() {
  const values = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ];
  return values.filter(value => typeof value === 'string' && value.trim()).flatMap(value => {
    try { return [realpathSync.native(value)]; } catch { return []; }
  });
}

function defaultBroadRoots() {
  return [homedir(), path.dirname(homedir())].flatMap(value => {
    try { return [realpathSync.native(value)]; } catch { return []; }
  });
}

export function validateWorkspaceRoot(value, {
  protectedRoots = defaultProtectedRoots(),
  broadRoots = defaultBroadRoots(),
} = {}) {
  const root = canonicalDirectory(value);
  if (samePath(root, path.parse(root).root)) throw Error('不能授权整个磁盘作为工作区');
  for (const broadRoot of broadRoots) {
    if (samePath(root, canonicalDirectory(broadRoot))) throw Error('不能授权过宽的用户或系统目录');
  }
  for (const protectedRoot of protectedRoots) {
    const canonicalProtected = canonicalDirectory(protectedRoot);
    if (inside(canonicalProtected, root)) throw Error('不能授权系统保护目录或其子目录');
  }
  return root;
}

function guardedWorkspaceTool(tool, epoch) {
  return Object.freeze({
    descriptor: tool.descriptor,
    async execute(input, context) {
      const signal = AbortSignal.any([context.signal, epoch.signal]);
      const result = await tool.execute(input, {...context, signal});
      if (epoch.signal.aborted) throw Error('工作区授权已撤销，读取结果已丢弃');
      return result;
    },
  });
}

export class WorkspaceAccess {
  constructor({selectDirectory, protectedRoots, broadRoots, toolFactory} = {}) {
    if (typeof selectDirectory !== 'function') throw Error('Workspace directory selector is required');
    this.selectDirectory = selectDirectory;
    this.protectedRoots = protectedRoots;
    this.broadRoots = broadRoots;
    this.toolFactories = toolFactory === undefined ? defaultToolFactories : Object.freeze([toolFactory]);
    this.epoch = new AbortController();
    this.root = undefined;
    this.workspaceTools = Object.freeze([]);
    this.revision = 0;
    this.selectionGeneration = 0;
  }

  snapshot() {
    return Object.freeze({
      configured: this.workspaceTools.length > 0,
      label: this.root ? path.basename(this.root) : '',
      status: this.workspaceTools.length > 0 ? 'authorized' : 'unavailable',
      revision: this.revision,
    });
  }

  tools() {
    return [...this.workspaceTools];
  }

  async select({isBusy = () => false, beforeCommit = () => {}, rendererPayload} = {}) {
    if (rendererPayload !== undefined) throw Error('工作区路径只能由主进程原生目录选择器提供');
    if (typeof isBusy !== 'function' || typeof beforeCommit !== 'function') throw Error('工作区授权宿主配置无效');
    if (isBusy()) throw Error('存在未结束任务，不能更换工作区授权');
    const generation = ++this.selectionGeneration;
    const selected = await this.selectDirectory();
    if (generation !== this.selectionGeneration) {
      return {...this.snapshot(), changed: false, cancelled: true, stale: true};
    }
    if (selected === undefined) return {...this.snapshot(), changed: false, cancelled: true};
    if (isBusy()) throw Error('目录选择期间任务已开始，工作区授权保持不变');

    // A user-confirmed replacement invalidates the old epoch first.  If the
    // new directory is rejected, the former root is never silently revived.
    beforeCommit();
    this.revoke();
    const root = validateWorkspaceRoot(selected, {
      protectedRoots: this.protectedRoots,
      broadRoots: this.broadRoots,
    });
    const epoch = new AbortController();
    const tools = this.toolFactories.map(factory => guardedWorkspaceTool(factory({rootPath: root}), epoch));
    this.epoch = epoch;
    this.root = root;
    this.workspaceTools = Object.freeze(tools);
    this.revision += 1;
    return {...this.snapshot(), changed: true, cancelled: false};
  }

  revoke({rendererPayload} = {}) {
    if (rendererPayload !== undefined) throw Error('撤销工作区授权不接受 Renderer 参数');
    this.selectionGeneration += 1;
    const changed = Boolean(this.workspaceTools.length || this.root);
    this.epoch.abort();
    this.epoch = new AbortController();
    this.root = undefined;
    this.workspaceTools = Object.freeze([]);
    if (changed) this.revision += 1;
    return {...this.snapshot(), changed};
  }
}
