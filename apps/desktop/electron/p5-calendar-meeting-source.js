import {createHash} from 'node:crypto';

const text = value => typeof value === 'string' && value.trim().length > 0;
const review = reason => ({status: 'requires_review', reason, calendarWriteVerified: false});
const utc = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

function bindingValid(binding) {
  return binding && ['accountRef', 'calendarId', 'externalId', 'sourceRef', 'meetingFactId']
    .every(key => text(binding[key]));
}

function projectItem(item, binding) {
  if (!item || item.source !== 'calendar' || item.accountRef !== binding.accountRef
    || item.externalId !== binding.externalId || !text(item.contentRef) || !utc(item.fetchedAt)) return;
  const prefix = `calendar:${binding.calendarId}:${binding.externalId}:`;
  if (typeof item.dedupeKey !== 'string' || !item.dedupeKey.startsWith(prefix)) return;
  const sequence = item.dedupeKey.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(sequence) || !Number.isSafeInteger(Number(sequence))) return;
  const interval = typeof item.validFor === 'string' ? item.validFor.split('/') : [];
  if (interval.length !== 2 || !interval.every(utc)
    || Date.parse(interval[1]) <= Date.parse(interval[0])
    || !utc(item.occurredAt) || Date.parse(item.occurredAt) !== Date.parse(interval[0])) return;
  const status = /^\[(confirmed|tentative|cancelled)\] /.exec(item.contentRef)?.[1];
  if (!status) return;
  return {sequence: Number(sequence), start: Date.parse(interval[0]), end: Date.parse(interval[1]),
    status, summary: item.contentRef, fetchedAt: Date.parse(item.fetchedAt)};
}

function boundedRead(read, binding, context, now) {
  return new Promise((resolve, reject) => {
    let timer, done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true; clearTimeout(timer); context.signal.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve(value);
    };
    const cancelled = () => finish(undefined, {code: 'CANCELLED'});
    const expire = () => {
      const remaining = Date.parse(context.deadline) - now();
      if (remaining <= 0) finish(undefined, {code: 'DEADLINE'});
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    context.signal.addEventListener('abort', cancelled, {once: true});
    if (context.signal.aborted) {cancelled(); return;}
    expire();
    if (!done) Promise.resolve().then(() => read({...binding}, {...context})).then(
      value => finish(value), error => finish(undefined, error));
  });
}

/** Consumes P1's public ConnectorItem. Binding and old item must come from a trusted host.
 * validFor is the event interval, never the freshness interval of an already-known Fact.
 * No provider write, source store or inferred deletion is performed here.
 */
export function projectCalendarMeetingChange({binding, baseline, current, detectedAt, deadline, signal}) {
  if (!bindingValid(binding) || !utc(detectedAt) || !utc(deadline)
    || !signal || typeof signal.aborted !== 'boolean') return review('invalid_binding_or_context');
  if (signal.aborted) return review('cancelled');
  if (Date.parse(detectedAt) >= Date.parse(deadline)) return review('deadline');
  if (!baseline) return review('baseline_unavailable');
  if (!current) return review('source_not_found');
  const old = projectItem(baseline, binding);
  const next = projectItem(current, binding);
  if (!old || !next) return review('source_mismatch_or_invalid');
  if (old.fetchedAt > Date.parse(detectedAt) || next.fetchedAt > Date.parse(detectedAt)
    || next.fetchedAt < old.fetchedAt) return review('source_readback_stale');
  if (old.status !== 'confirmed' || next.status !== 'confirmed') return review('status_requires_review');
  if (next.sequence < old.sequence) return review('source_revision_regressed');
  if (next.sequence === old.sequence) {
    return next.summary === old.summary && next.start === old.start && next.end === old.end
      ? {status: 'unchanged', calendarWriteVerified: false} : review('source_revision_conflict');
  }
  if (next.start === old.start && next.end === old.end) return review('metadata_change_requires_review');
  if (next.summary === old.summary) return review('source_projection_conflict');
  const identity = Object.fromEntries(['accountRef', 'calendarId', 'externalId', 'sourceRef', 'meetingFactId']
    .map(key => [key, binding[key]]));
  const eventId = createHash('sha256').update(JSON.stringify({binding: identity,
    baseSequence: old.sequence, sourceSequence: next.sequence,
    originalSummary: old.summary, newSummary: next.summary,
    interval: [next.start, next.end]})).digest('hex');
  return {status: 'changed', calendarWriteVerified: false, event: {
    eventId: `calendar-change:${eventId}`, source: binding.sourceRef,
    meetingFactId: binding.meetingFactId, originalSummary: old.summary,
    newSummary: next.summary, expectedBaseRevision: String(old.sequence),
    sourceRevision: String(next.sequence), detectedAt, deadline, signal,
  }};
}

/** Public getEventItem can be wrapped in readCurrent by the trusted composition after
 * Runtime/Policy authorizes the read. readBaseline reuses existing durable projections.
 * Late reads never reach Laya/CAS; NOT_FOUND cannot withdraw the Fact.
 */
export function createCalendarMeetingSource({readCurrent, readBaseline, processMeetingEvent,
  now = Date.now, onUpdate = () => {}}) {
  if (![readCurrent, readBaseline, processMeetingEvent].every(value => typeof value === 'function')) {
    throw new Error('Calendar source requires trusted read and meeting ports');
  }
  let tail = Promise.resolve();
  let feedback = {status: 'unobserved', calendarWriteVerified: false};
  const publish = value => {
    feedback = {status: value.status, ...(value.reason ? {reason: value.reason} : {}),
      calendarWriteVerified: false};
    try { onUpdate({...feedback}); } catch {}
    return value;
  };
  const stopped = context => context?.signal?.aborted ? review('cancelled')
    : !utc(context?.deadline) || now() >= Date.parse(context.deadline) ? review('deadline') : undefined;
  return {
    snapshot: () => ({...feedback}),
    refresh(binding, context) {
      // Take a stable copy before queueing; callers cannot swap identity during a read.
      const bound = bindingValid(binding) ? {
        accountRef: binding.accountRef, calendarId: binding.calendarId, externalId: binding.externalId,
        sourceRef: binding.sourceRef, meetingFactId: binding.meetingFactId,
      } : undefined;
      const ctx = {deadline: context?.deadline, signal: context?.signal};
      const operation = tail.then(async () => {
        if (!bound || !ctx.signal || typeof ctx.signal.aborted !== 'boolean') {
          return publish(review('invalid_binding_or_context'));
        }
        let result = stopped(ctx);
        if (result) return publish(result);
        try {
          const baseline = structuredClone(await boundedRead(readBaseline, bound, ctx, now));
          result = stopped(ctx);
          if (result) return publish(result);
          if (!baseline) return publish(review('baseline_unavailable'));
          const current = await boundedRead(readCurrent, bound, ctx, now);
          result = stopped(ctx);
          if (result) return publish(result);
          result = projectCalendarMeetingChange({binding: bound, baseline, current,
            detectedAt: new Date(now()).toISOString(), ...ctx});
          if (result.status !== 'changed') return publish(result);
          const receipt = await processMeetingEvent(result.event);
          return publish({status: 'processed', receipt, calendarWriteVerified: false});
        } catch (error) {
          return publish(stopped(ctx) ?? review(error?.code === 'CANCELLED' ? 'cancelled'
            : error?.code === 'DEADLINE' ? 'deadline'
            : error?.code === 'NOT_FOUND' ? 'source_not_found' : 'source_or_processing_unavailable'));
        }
      });
      tail = operation.then(() => {}, () => {});
      return operation;
    },
  };
}
