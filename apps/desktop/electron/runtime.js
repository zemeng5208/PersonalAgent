import {Client} from '@personal-agent/client';

export const AGENTARTS_TASK_TIMEOUT_MS = 180_000;

export function taskSubmitOptions(competitionMode, idempotencyKey) {
  return competitionMode
    ? {idempotencyKey, timeoutMs: AGENTARTS_TASK_TIMEOUT_MS}
    : {idempotencyKey};
}

// MOD-11 integration entry. The trusted host supplies the MOD-02 transport.
// No fallback runtime, private database or credentials are owned by the renderer.
export async function register(host) {
  const client = new Client(host.transport, host.now ?? Date.now);
  await client.connect();
  const release = host.attachClient?.(client);
  return {
    client,
    readEvents: host.readEvents,
    dispose() {
      release?.();
    },
  };
}
