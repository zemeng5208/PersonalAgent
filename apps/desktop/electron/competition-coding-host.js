import {randomUUID} from 'node:crypto';
import {createDesktopCodingToolHost} from './coding-tool-host.js';

const TOOL_VERSION = '1.0.0';
const TOOL_NAMES = Object.freeze({
  stage: 'workspace.stage_text_patch',
  apply: 'workspace.apply_text_patch',
  command: 'workspace.run_allowed_command',
});
const DEADLINE_MS = 10 * 60 * 1000;

/** Explicit host tool tasks; this does not add coding tools to the cloud export catalog. */
export function createDesktopCompetitionCodingHost({workspaceRoot, recoveryRootPath, powerShellPath,
  createWorkspacePatchStageTool, createWorkspacePatchApplyTool, createWorkspaceCommandTool}) {
  const apply = createDesktopCodingToolHost({workspaceRoot, authorizedWorkspaceRoot: workspaceRoot,
    recoveryRootPath, powerShellPath, createWorkspacePatchApplyTool});
  let application;
  try {
    const stage = createWorkspacePatchStageTool({rootPath: workspaceRoot});
    const command = createWorkspaceCommandTool({rootPath: workspaceRoot, recipes: [{
      id: 'verify-synthetic-repair', executable: powerShellPath,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$p=Join-Path (Get-Location) 'repair.txt'; if(-not (Test-Path -LiteralPath $p -PathType Leaf)){exit 2}; $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant(); [Console]::Out.Write($h)"],
    }]});
    const tools = [...apply.tools, stage, command];
    for (const tool of tools) {
      if (!Object.values(TOOL_NAMES).includes(tool.descriptor.name)
        || tool.descriptor.version !== TOOL_VERSION) throw Error('Unexpected coding tool descriptor');
    }
    const guarded = tools.map(tool => ({descriptor: tool.descriptor, execute: (input, context) => {
      if (!apply.available()) throw Error('Coding tool host requires trusted reconciliation');
      return tool.execute(input, context);
    }}));
    return Object.freeze({
      tools: guarded,
      available: apply.available,
      bind(value) { if (application) throw Error('Coding host is already bound'); application = value; },
      submit(operation, input) {
        if (!application || !apply.available()) throw Error('Coding tool host is unavailable');
        const toolName = TOOL_NAMES[operation];
        if (!toolName) throw Error('Unsupported coding operation');
        return application.submitHostToolTask({commandId: randomUUID(), toolName,
          toolVersion: TOOL_VERSION, arguments: input,
          deadline: new Date(Date.now() + DEADLINE_MS).toISOString()});
      },
      readTask(taskId) {
        if (!application || typeof taskId !== 'string') throw Error('Coding tool task is unavailable');
        const task = application.readHostToolTask(taskId);
        if (!Object.values(TOOL_NAMES).includes(task.toolName)) throw Error('Coding tool task is unavailable');
        return task;
      },
      close: apply.close,
    });
  } catch (error) { apply.close(); throw error; }
}
