import {createHash} from 'node:crypto';
import {ProtocolError} from '@personal-agent/contracts';
import type {ProtocolContracts} from '@personal-agent/contracts';

export interface FeedTransportReceipt {
  providerId: 'http-feed-provider-v1';
  nativeFetch: boolean;
  credentialFree: boolean;
  state: 'fetched' | 'unchanged';
  transportFetchedAt: string;
  requestBinding: string;
  decodedBodySha256: string | null;
}

export interface FeedItemCitation {
  externalId: string;
  contentRef: string;
  sourceRevision: string;
  contentSha256: string;
}

/** Source observation, never a grant. Only the trusted host decides export/tracking consent. */
export interface FeedSourceReceipt {
  version: 1;
  providerId: 'http-feed-provider-v1';
  source: string;
  subscriptionId: string;
  configBinding: string;
  sensitivity: string;
  publicFetch: boolean;
  sourceRevision: string;
  contentSha256: string;
  transport: FeedTransportReceipt;
  citations: FeedItemCitation[];
}

const observations = new WeakMap<object, FeedTransportReceipt>();
export const feedSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// Module-internal transport sealing; deliberately not exported through package exports.
export function sealFeedTransportReceipt(result: object, receipt: FeedTransportReceipt): void {
  observations.set(result, structuredClone(receipt));
}

/** Object identity is required. A JSON property/provider label cannot fabricate a transport observation. */
export function readFeedTransportReceipt(result: object): FeedTransportReceipt | undefined {
  const receipt = observations.get(result);
  return receipt === undefined ? undefined : structuredClone(receipt);
}

/** Returns a non-secret binding only. Never return/store the raw configured URL in a receipt. */
export function feedConfigBinding(subscription: {id: string; url: string; sensitivity?: string}, source: string): string {
  return feedSha256(JSON.stringify(['feed-config-v1', source, subscription.id.trim(),
    new URL(subscription.url).href, subscription.sensitivity?.trim() || 'public']));
}

export function feedItemContentSha256(item: {record: ProtocolContracts['connectorItem']; title: string; summary: string}): string {
  const r = item.record;
  return feedSha256(JSON.stringify([r.source, r.accountRef, r.externalId, r.occurredAt,
    r.contentRef, r.dedupeKey, item.title, item.summary]));
}

/** Conservative: query-bearing/capability URLs and private hosts never prove anonymous public access. */
export function credentialFreePublicUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local')
    && !host.endsWith('.internal') && !host.includes(':') && !/^\d+(?:\.\d+){3}$/u.test(host);
}

/** Verify the receipt against the exact returned page before using its per-item citations. */
export function assertFeedSourceReceiptMatches(
  receipt: FeedSourceReceipt,
  page: {items: {record: ProtocolContracts['connectorItem']; title: string; summary: string}[]},
  binding: {subscriptionId: string; configBinding: string},
): void {
  if (!receipt || receipt.version !== 1 || receipt.providerId !== 'http-feed-provider-v1'
    || receipt.subscriptionId !== binding.subscriptionId || receipt.configBinding !== binding.configBinding
    || receipt.transport?.providerId !== receipt.providerId || receipt.transport.state !== 'fetched'
    || !/^[a-f0-9]{64}$/u.test(receipt.transport.decodedBodySha256 ?? '')
    || !Number.isFinite(Date.parse(receipt.transport.transportFetchedAt))
    || !Array.isArray(receipt.citations) || !Array.isArray(page.items)
    || receipt.citations.length !== page.items.length
    || receipt.sourceRevision !== receipt.transport.decodedBodySha256
    || receipt.publicFetch !== (receipt.sensitivity === 'public' && receipt.transport.nativeFetch && receipt.transport.credentialFree)) {
    throw new ProtocolError('EXTERNAL_FAILURE', 'Feed source receipt does not match its source binding', false);
  }
  const hashes: string[] = [];
  for (let i = 0; i < page.items.length; i++) {
    const item = page.items[i]!;
    const citation = receipt.citations[i]!;
    const hash = feedItemContentSha256(item);
    if (!citation || item.record.source !== receipt.source || item.record.accountRef !== receipt.subscriptionId
      || item.record.sensitivity !== receipt.sensitivity || citation.externalId !== item.record.externalId
      || citation.contentRef !== item.record.contentRef || citation.contentSha256 !== hash
      || citation.sourceRevision !== receipt.sourceRevision) {
      throw new ProtocolError('EXTERNAL_FAILURE', 'Feed item citation does not match the returned item', false);
    }
    hashes.push(hash);
  }
  if (receipt.contentSha256 !== feedSha256(JSON.stringify(hashes))) {
    throw new ProtocolError('EXTERNAL_FAILURE', 'Feed source receipt page hash mismatch', false);
  }
}
