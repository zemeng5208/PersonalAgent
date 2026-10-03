import { ProtocolError } from '@personal-agent/contracts';
import type { GitHubInputs, GitHubOperation, GitHubOutputs, GitHubPort, GitHubProvider, GitHubReadContext } from './provider.js';
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new ProtocolError('CANCELLED', 'GitHub request cancelled')); };
    context.signal.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => { controller.abort(); reject(new ProtocolError('TIMEOUT', 'GitHub request deadline expired')); }, Math.min(2147483647, Date.parse(context.deadline) - Date.now()));
  });
  try { return await Promise.race([operation({signal: controller.signal, deadline: context.deadline}), stopped]); }
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
    return redactValue(await this.provider.execute(operation, input, context));
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.provider.dispose?.(); } }
}
