import {createWorkspaceReadTool, WORKSPACE_READ_TOOL_NAME, WORKSPACE_READ_TOOL_VERSION} from '@personal-agent/coding-tools';

export const SYNTHETIC_MEETING_PATH = 'meeting-update.json';
const MAX_BYTES = 2048;
const approvedKeys = ['meetingId', 'revision', 'start', 'timezone'];
const approved = Object.freeze({meetingId: 'mvp-meeting', revision: 2, start: '17:00', timezone: 'Asia/Shanghai'});

function exactDataObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

/** An explicit synthetic-only export gate, never execution authority. */
export function projectSyntheticMeetingResult(result) {
  const deny = () => { throw Error('Synthetic meeting result export denied'); };
  if (!exactDataObject(result, ['path', 'encoding', 'byteLength', 'content'])
    || result.path !== SYNTHETIC_MEETING_PATH || result.encoding !== 'utf-8'
    || typeof result.content !== 'string' || !Number.isSafeInteger(result.byteLength)
    || result.byteLength < 1 || result.byteLength > MAX_BYTES
    || Buffer.byteLength(result.content, 'utf8') !== result.byteLength) return deny();
  let parsed;
  try { parsed = JSON.parse(result.content); } catch { return deny(); }
  if (!exactDataObject(parsed, approvedKeys)
    || approvedKeys.some(key => parsed[key] !== approved[key])) return deny();
  // Derived from the confirmed tool result, not a fallback if the read failed.
  // Never include the raw file, local path, credentials or an Evidence claim.
  return {meetingId: parsed.meetingId, revision: parsed.revision, start: parsed.start, timezone: parsed.timezone};
}

/** Called only by trusted Competition composition with the dedicated fixture root. */
export function createSyntheticMeetingToolset(rootPath) {
  const tool = createWorkspaceReadTool({rootPath, maxReadBytes: MAX_BYTES});
  return {
    tools: [tool],
    competitionToolExports: [{
      toolName: WORKSPACE_READ_TOOL_NAME,
      toolVersion: WORKSPACE_READ_TOOL_VERSION,
      exportPolicyVersion: 'synthetic-meeting-v1',
      accepts: ({arguments: args}) => exactDataObject(args, ['path']) && args.path === SYNTHETIC_MEETING_PATH,
      project: ({result, signal}) => {
        if (signal.aborted) throw Error('Synthetic meeting result export cancelled');
        return projectSyntheticMeetingResult(result);
      },
    }],
  };
}
