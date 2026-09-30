/** A missing configuration defers startup without creating any runtime resources.
 * Once initialization begins, share that attempt; partial failures require a clean restart.
 */
export function createDeferredRuntimeStartup({isConfigured, initialize}) {
  let state = 'idle', pending;
  const snapshot = () => ({state: state === 'idle' && !isConfigured() ? 'configuration_required' : state});
  return {
    snapshot,
    start() {
      if (pending) return pending;
      if (!isConfigured()) return Promise.resolve(snapshot());
      state = 'starting';
      pending = Promise.resolve().then(initialize).then(
        () => {state = 'ready';},
        () => {state = 'failed';},
      ).then(snapshot);
      return pending;
    },
  };
}
