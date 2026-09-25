import {lstat, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const TOOL_NAME = 'workspace.read_text';
const TOOL_VERSION = '1.0.0';
const FIXTURE_NAME = 'meeting-update.json';
const FIXTURE_CONTENT = '{"meetingId":"mvp-meeting","revision":2,"start":"17:00","timezone":"Asia/Shanghai"}\n';
const BASELINE_NAME = 'meeting-baseline.json';
const BASELINE_CONTENT = '{"meetingId":"mvp-meeting","revision":1,"start":"15:00","timezone":"Asia/Shanghai"}\n';
const MAX_READ_BYTES = 4096;

function expectedFixture(content, expected) {
  return content === expected || content === expected.replace(/\n/g, '\r\n');
}

/** Only the bundled synthetic file may be selected or exported to AgentArts. */
export function createDesktopCompetitionToolCatalog({rootPath, createWorkspaceReadTool, now = Date.now}) {
  const fixturePath = path.join(rootPath, FIXTURE_NAME);
  const baselinePath = path.join(rootPath, BASELINE_NAME);
  const tool = createWorkspaceReadTool({rootPath, maxReadBytes: MAX_READ_BYTES});
  if (tool.descriptor.name !== TOOL_NAME || tool.descriptor.version !== TOOL_VERSION
    || tool.descriptor.sideEffect !== 'read') throw Error('Unexpected Competition read tool');
  let active = true;
  const readApprovedFixture = async (filePath, expected) => {
    if (!active) throw Error('Synthetic meeting source is unavailable');
    try {
      const file = await lstat(filePath);
      if (!file.isFile() || file.size > MAX_READ_BYTES) throw Error();
      const content = await readFile(filePath, 'utf8');
      if (file.size !== Buffer.byteLength(content, 'utf8') || !expectedFixture(content, expected)) throw Error();
      return Object.freeze({meeting: Object.freeze(JSON.parse(expected)),
        sourceRevision: createHash('sha256').update(expected).digest('hex')});
    } catch { throw Error('Synthetic meeting source is unavailable'); }
  };
  const readSyntheticMeetingSource = () => readApprovedFixture(fixturePath, FIXTURE_CONTENT);
  const readSyntheticMeetingUpdate = async () => (await readSyntheticMeetingSource()).meeting;
  const fixtureReady = async () => {
    try { await readSyntheticMeetingSource(); return true; } catch { return false; }
  };
  return {
    tool,
    readSyntheticMeetingUpdate,
    readSyntheticMeetingSource,
    readSyntheticMeetingBaseline: () => readApprovedFixture(baselinePath, BASELINE_CONTENT),
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
          || !expectedFixture(result.content, FIXTURE_CONTENT)
          || result.byteLength !== Buffer.byteLength(result.content, 'utf8')) {
          throw Error('Synthetic Competition result is unavailable');
        }
        return {content: FIXTURE_CONTENT};
      },
    },
    close: () => { active = false; },
  };
}
