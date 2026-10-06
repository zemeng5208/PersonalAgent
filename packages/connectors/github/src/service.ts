import { ProtocolError } from '@personal-agent/contracts';
import type { GitHubInputs, GitHubOperation, GitHubOutputs, GitHubPort, GitHubProvider, GitHubReadContext } from './provider.js';
import { isGitHubWrite } from './provider.js';
import { validateInput } from './schemas.js';
import { redactValue } from './redact.js';

export function checkContext(context: GitHubReadContext): void {
  if (!context?.signal || !Number.isFinite(Date.parse(context.deadline))) throw new ProtocolError('INVALID_ARGUMENT', 'GitHub calls require a signal and absolute deadline');
  if (context.signal.aborted) throw new ProtocolError('CANCELLED', 'GitHub request cancelled');
  if (Date.parse(context.deadline) <= Date.now()) throw new ProtocolError('TIMEOUT', 'GitHub request deadline expired');
}
/** Bounds even an injected port that fails to observe cancellation. */
export async function withGitHubContext<T>(context: GitHubReadContext, operation: (context: GitHubReadContext) => Promise<T>): Promise<T> {
  checkContext(context);
  const controller = new AbortController();
  const deadlineMs = Date.parse(context.deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let interruption: ProtocolError | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = (error: ProtocolError): void => {
      interruption ??= error;
      controller.abort();
      reject(interruption);
    };
    abort = () => stop(new ProtocolError('CANCELLED', 'GitHub request cancelled'));
    context.signal.addEventListener('abort', abort, {once: true});
    const expire = (): void => {
      if (controller.signal.aborted) return;
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) stop(new ProtocolError('TIMEOUT', 'GitHub request deadline expired'));
      else timer = setTimeout(expire, Math.min(2147483647, remaining));
    };
    if (context.signal.aborted) abort();
    expire();
  });
  try {
    // Capture synchronous throws as a promise so both race branches always
    // acquire handlers, including a provider that cancels and then throws.
    const running = new Promise<T>((resolve, reject) => {
      try {
        checkContext(context);
        if (interruption) throw interruption;
        resolve(operation({signal: controller.signal, deadline: context.deadline}));
      } catch (error) { reject(error); }
    });
    // A port may block the event loop or settle before an interrupt microtask.
    // Either settlement must still respect interruption and the original lease.
    const checkCompletion = (): void => {
      if (interruption) throw interruption;
      try { checkContext(context); }
      catch (error) { controller.abort(); throw error; }
    };
    let result: T;
    try { result = await Promise.race([running, stopped]); }
    catch (error) { checkCompletion(); throw error; }
    checkCompletion();
    return result;
  }
  finally { if (timer !== undefined) clearTimeout(timer); if (abort) context.signal.removeEventListener('abort', abort); }
}
export class GitHubService implements GitHubPort {
  private disposed = false;
  constructor(readonly provider: GitHubProvider) {
    if (!provider) throw new ProtocolError('INVALID_ARGUMENT', 'Explicit GitHub provider required');
  }
  async execute<K extends GitHubOperation>(operation: K, input: GitHubInputs[K], context: GitHubReadContext): Promise<GitHubOutputs[K]> {
    if (this.disposed) throw new ProtocolError('UNSUPPORTED_CAPABILITY', 'GitHub module disposed');
    validateInput(operation, input);
    checkContext(context);
    try {
      return redactValue(await withGitHubContext(context, bounded => this.provider.execute(operation, input, bounded)));
    } catch (error) {
      // After entering a write provider, cancellation cannot prove that no effect occurred.
      if (isGitHubWrite(operation) && error instanceof ProtocolError && ['CANCELLED', 'TIMEOUT'].includes(error.code)) {
        return {state: 'unknown', evidenceRefs: []} as unknown as GitHubOutputs[K];
      }
      throw error;
    }
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.provider.dispose?.(); } }
}
