import { ProtocolError } from '@personal-agent/contracts';
import type { CalendarReadContext } from './provider.js';

export function assertReadActive(context?: CalendarReadContext, now: () => number = Date.now): void {
  if (context?.signal?.aborted) throw new ProtocolError('CANCELLED', 'Calendar read cancelled');
  if (context?.deadline !== undefined) {
    const deadlineMs = Date.parse(context.deadline);
    if (!Number.isFinite(deadlineMs)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid calendar read deadline');
    if (deadlineMs <= now()) throw new ProtocolError('TIMEOUT', 'Calendar read deadline exceeded', true);
  }
}
