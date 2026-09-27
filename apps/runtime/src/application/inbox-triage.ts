import {createHash} from 'node:crypto';
import {ProtocolError, validateContract} from '@personal-agent/contracts';
import type {ProtocolContracts, StoragePort} from '@personal-agent/contracts';
import type {LayaTriageService} from '@personal-agent/cognition';

export interface InboxTriageContext {readonly deadline: string; readonly signal: AbortSignal;}
export interface InboxTriagePage extends InboxTriageContext {
  readonly accountRef: string;
  readonly folder: string;
  readonly cursor?: string;
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly items: readonly ProtocolContracts['connectorItem'][];
}
export interface InboxTriageMetadata {
  readonly messageId: string;
  readonly sourceRevision: string;
  readonly mailboxId: string;
  readonly sensitivity: 'private';
  readonly headersOnly: true;
  readonly label: string | null;
  readonly route: 'group' | 'review' | 'main_agent';
  readonly needsReview: boolean;
  readonly highImpactCandidate: boolean;
  /** A classifier hint only: no confirmed meeting identity, time or Fact is created. */
  readonly meetingCandidate: boolean;
}
interface State {
  version: 1;
  records: Record<string, InboxTriageMetadata>;
  latest: Record<string, string>;
  cursors: Record<string, string>;
}
export interface InboxTriageOptions {
  readonly storage: StoragePort;
  /** Host-owned, user-isolated namespace. Storage must atomically replace one key. */
  readonly namespace: string;
  readonly triage: Pick<LayaTriageService, 'classify'>;
  readonly labels: Readonly<Record<string, string>>;
  readonly meetingLabels?: readonly string[];
  /** Checks the current local processing lease, not cloud export permission. */
  readonly authorizeRead: (scope: {accountRef: string; folder: string} & InboxTriageContext) => boolean;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unfinished = new Set(['unavailable', 'invalid_response', 'cancelled', 'deadline']);
function reject(message: string): never {throw new ProtocolError('INVALID_ARGUMENT', message);}
function text(value: unknown): value is string {return typeof value === 'string' && value.trim().length > 0;}

/** Local derived metadata only. Single owner per namespace; no mail writes, Fact writes or task store. */
export function createInboxTriagePipeline(options: InboxTriageOptions) {
  if (!text(options.namespace) || !options.storage || typeof options.triage?.classify !== 'function'
    || typeof options.authorizeRead !== 'function') reject('Inbox triage host configuration is invalid');
  const labels = structuredClone(options.labels);
  if (!labels || Object.keys(labels).length < 2 || Object.values(labels).some(value => !text(value))) {
    reject('Inbox labels must contain at least two definitions');
  }
  const meetingLabels = new Set(options.meetingLabels ?? []);
  if ([...meetingLabels].some(label => !Object.hasOwn(labels, label))) reject('Unknown meeting label');
  const storageKey = `inbox-triage:v1:${hash([options.namespace, labels, [...meetingLabels].sort()])}`;
  let busy = false;
  const load = (): State => {
    const saved = options.storage.get(storageKey);
    if (saved === undefined || saved === null) return {version: 1, records: {}, latest: {}, cursors: {}};
    const state = structuredClone(saved) as State;
    if (!state || state.version !== 1 || !state.records || !state.latest || !state.cursors
      || Array.isArray(state.records) || Array.isArray(state.latest) || Array.isArray(state.cursors)
      || Object.values(state.records).some(item => !item || item.sensitivity !== 'private' || item.headersOnly !== true)
      || Object.values(state.latest).some(key => typeof key !== 'string' || !state.records[key])
      || Object.values(state.cursors).some(value => typeof value !== 'string')) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Inbox triage state needs recovery');
    }
    return state;
  };
  const save = (state: State): void => options.storage.set(storageKey, structuredClone(state));
  const check = (page: InboxTriagePage): void => {
    if (page.signal.aborted) throw new ProtocolError('CANCELLED', 'Inbox triage cancelled');
    if (Date.now() >= Date.parse(page.deadline)) throw new ProtocolError('TIMEOUT', 'Inbox triage deadline expired');
    if (options.authorizeRead({accountRef: page.accountRef, folder: page.folder,
      deadline: page.deadline, signal: page.signal}) !== true) {
      throw new ProtocolError('UNAUTHORIZED', 'Local inbox processing is not authorized');
    }
  };
  const snapshot = () => {
    const state = load();
    const records = Object.values(state.latest).map(key => state.records[key]!);
    const groups: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const row of records) if (row.label !== null) groups[row.label] = (groups[row.label] ?? 0) + 1;
    return structuredClone({records, groups, total: records.length,
      needsReview: records.filter(row => row.needsReview).length,
      highImpactCandidates: records.filter(row => row.highImpactCandidate).length,
      meetingCandidates: records.filter(row => row.meetingCandidate).length});
  };
  return Object.freeze({
    snapshot,
    cursor: (accountRef: string, folder: string): string | undefined => load().cursors[hash([accountRef, folder])],
    async processPage(input: InboxTriagePage) {
      if (busy) throw new ProtocolError('REVISION_CONFLICT', 'Inbox triage is already processing a page');
      if (!input || !text(input.accountRef) || !text(input.folder) || typeof input.nextCursor !== 'string'
        || (input.cursor !== undefined && typeof input.cursor !== 'string') || typeof input.hasMore !== 'boolean'
        || !Array.isArray(input.items) || input.items.length > 100 || !(input.signal instanceof AbortSignal)
        || !Number.isFinite(Date.parse(input.deadline))) reject('Invalid inbox page');
      const page: InboxTriagePage = {...input, items: structuredClone(input.items)};
      check(page);
      const mailboxId = hash([page.accountRef, page.folder]);
      const messages = page.items.map(item => {
        validateContract('connectorItem', item);
        if (item.source !== 'mail' || item.sensitivity !== 'private' || item.accountRef !== page.accountRef
          || !item.externalId.startsWith(`${page.folder}:`)) reject('Inbox source must remain private and bound to its mailbox');
        const messageId = hash([page.accountRef, page.folder, item.externalId, item.dedupeKey]);
        // Missing Date headers use fetchedAt; refetch time is not a source change.
        const sourceRevision = hash([item.dedupeKey, item.contentRef,
          item.occurredAt === item.fetchedAt ? null : item.occurredAt]);
        return {source: 'mail', messageId, sourceRevision, text: item.contentRef};
      });
      const revisions = new Map<string, string>();
      for (const message of messages) {
        if (revisions.has(message.messageId) && revisions.get(message.messageId) !== message.sourceRevision) {
          reject('An inbox page contains conflicting versions');
        }
        revisions.set(message.messageId, message.sourceRevision);
      }
      busy = true;
      try {
        const state = load();
        const storedCursor = state.cursors[mailboxId];
        const storedParts = storedCursor?.match(/^(\d+):(\d+)$/);
        const pageParts = page.nextCursor.match(/^(\d+):(\d+)$/);
        // A fresh process-local read session starts at INBOX's first page. Replaying
        // confirmed earlier pages may refresh classifications but cannot rewind progress.
        const historical = Boolean(storedParts && pageParts && storedParts[1] === pageParts[1]
          && BigInt(storedParts[2]!) > BigInt(pageParts[2]!));
        if (!historical && storedCursor !== (page.cursor || undefined) && storedCursor !== page.nextCursor) {
          throw new ProtocolError('REVISION_CONFLICT', 'Inbox page does not match the persisted cursor');
        }
        const unique = [...new Map(messages.map(message => [message.messageId, message])).values()];
        const pending = unique.filter(message => !state.records[hash([message.messageId, message.sourceRevision])]);
        let classified = 0;
        let incomplete = false;
        // The public Laya service bounds each batch; persist completed chunks before proceeding.
        for (let index = 0; index < pending.length; index += 4) {
          check(page);
          const batch = pending.slice(index, index + 4);
          const results = await options.triage.classify({messages: batch, labels,
            deadline: page.deadline, signal: page.signal});
          check(page);
          if (!Array.isArray(results) || results.length !== batch.length) {
            throw new ProtocolError('EXTERNAL_FAILURE', 'Inbox classifier returned an invalid batch');
          }
          for (let offset = 0; offset < batch.length; offset++) {
            const message = batch[offset]!;
            const result = results[offset]!;
            if (!result || result.source !== message.source || result.messageId !== message.messageId
              || result.sourceRevision !== message.sourceRevision
              || !['group', 'review', 'main_agent'].includes(result.route)
              || (result.label !== null && !Object.hasOwn(labels, result.label))) {
              throw new ProtocolError('EXTERNAL_FAILURE', 'Inbox classifier correlation failed');
            }
            if (unfinished.has(result.reason)) {incomplete = true; continue;}
            const key = hash([message.messageId, message.sourceRevision]);
            state.records[key] = {messageId: message.messageId, sourceRevision: message.sourceRevision, mailboxId,
              sensitivity: 'private', headersOnly: true, label: result.label, route: result.route,
              needsReview: result.route !== 'group' || result.abstained
                || (result.label !== null && meetingLabels.has(result.label)),
              highImpactCandidate: result.route === 'main_agent',
              meetingCandidate: result.label !== null && meetingLabels.has(result.label)};
            state.latest[message.messageId] = key;
            classified++;
          }
          save(state);
        }
        // Cached revisions must also become the latest visible observation after replay.
        for (const message of unique) {
          const key = hash([message.messageId, message.sourceRevision]);
          if (state.records[key]) state.latest[message.messageId] = key;
          else incomplete = true;
        }
        check(page);
        if (!incomplete && !historical) state.cursors[mailboxId] = page.nextCursor;
        save(state);
        return {classified, reused: unique.length - pending.length, complete: !incomplete,
          cursorAdvanced: !incomplete && !historical, nextCursor: state.cursors[mailboxId], hasMore: page.hasMore,
          summary: snapshot()};
      } finally {busy = false;}
    },
  });
}
