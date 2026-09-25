import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';

const TOOL_NAME = 'workspace.read_text';
const TOOL_VERSION = '1.0.0';
const FIXTURE_NAME = 'meeting-update.json';
const FIXTURE_CONTENT = '{"kind":"synthetic-meeting-update","revision":1,"meeting":"Competition MVP fixture","update":"The synthetic review is scheduled for Friday.","owner":"Example Team"}\n';
const MAX_READ_BYTES = 4096;

/** Only the bundled synthetic file may be selected or exported to AgentArts. */
export function createDesktopCompetitionToolCatalog({rootPath, createWorkspaceReadTool, now = Date.now}) {
  const fixturePath = path.join(rootPath, FIXTURE_NAME);
  const tool = createWorkspaceReadTool({rootPath, maxReadBytes: MAX_READ_BYTES});
  if (tool.descriptor.name !== TOOL_NAME || tool.descriptor.version !== TOOL_VERSION
    || tool.descriptor.sideEffect !== 'read') throw Error('Unexpected Competition read tool');
  let active = true;
  const fixtureReady = async () => {
    if (!active) return false;
    try {
      const file = await lstat(fixturePath);
      if (!file.isFile() || file.size !== Buffer.byteLength(FIXTURE_CONTENT, 'utf8')) return false;
      return await readFile(fixturePath, 'utf8') === FIXTURE_CONTENT;
    } catch { return false; }
  };
  return {
    tool,
    availability: {
      toolName: TOOL_NAME,
      toolVersion: TOOL_VERSION,
      available: async ({taskId, revision, deadline, signal}) => {
        if (signal.aborted || typeof taskId !== 'string' || !taskId
          || !Number.isSafeInteger(revision) || revision < 1
          || !Number.isFinite(Date.parse(deadline)) || now() >= Date.parse(deadline)) return false;
        return fixtureReady();
      },
    },
    export: {
      toolName: TOOL_NAME,
      toolVersion: TOOL_VERSION,
      exportPolicyVersion: 'synthetic-meeting-v1',
      accepts: ({arguments: args}) => active && args !== null && typeof args === 'object'
        && !Array.isArray(args) && Object.keys(args).length === 1 && args.path === FIXTURE_NAME,
      project: async ({result, signal}) => {
        if (signal.aborted || !await fixtureReady() || !result || typeof result !== 'object'
          || result.path !== FIXTURE_NAME || result.encoding !== 'utf-8'
          || result.content !== FIXTURE_CONTENT
          || result.byteLength !== Buffer.byteLength(FIXTURE_CONTENT, 'utf8')) {
          throw Error('Synthetic Competition result is unavailable');
        }
        return {content: FIXTURE_CONTENT};
      },
    },
    close: () => { active = false; },
  };
}
