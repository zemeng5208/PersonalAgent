import { ProtocolError } from '@personal-agent/contracts';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Normalized feed document: raw text only, no interpretation.
 *
 * Date resolution and identifier selection live in `service.ts` because they carry provenance
 * (`occurredAtKind`, `dedupeKeyKind`) that has to be reported alongside the record. This layer's
 * job is to turn hostile, inconsistent XML into flat strings without inventing anything.
 */
export interface FeedEntryText {
  /** Position in the document. Used for stable sorting and for `skipped[].index`. */
  index: number;
  title: string;
  link: string;
  /** RSS `<guid>` / Atom `<id>`, exactly as published. Empty when the source gave none. */
  nativeId: string;
  publishedText: string;
  updatedText: string;
  bodyText: string;
}

export interface FeedDocument {
  kind: 'rss' | 'atom';
  title: string;
  /** Feed-level timestamp text (`lastBuildDate` / `<updated>`), the last resort for `occurredAt`. */
  buildText: string;
  entries: FeedEntryText[];
}

/**
 * Characters, not bytes — the transport enforces the byte cap while streaming. This second check
 * exists so a fixture-driven provider cannot bypass it, and so the limit is testable offline
 * without committing a multi-megabyte file.
 */
export const MAX_BODY_CHARS = 5_000_000;
export const SUMMARY_LIMIT = 280;

const FEED_ROOTS = new Set(['rss', 'feed']);

/**
 * `processEntities: false` is the security decision, not a convenience. With it the parser never
 * expands a DOCTYPE-declared entity, so entity-expansion ("billion laughs") is structurally
 * impossible rather than merely rate-limited. The cost is that `&amp;` and friends arrive intact
 * and must be decoded here, by `decodeXmlEntities`, which knows exactly six things.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name: string) => {
    const local = localName(name);
    return local === 'item' || local === 'entry' || local === 'link';
  },
});

const localName = (tag: string): string => {
  const colon = tag.lastIndexOf(':');
  return colon < 0 ? tag : tag.slice(colon + 1);
};

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

const ENTITY_REFERENCE = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/g;

function decodeReference(reference: string): string {
  const body = reference.slice(1, -1);
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    // Unrepresentable code points stay literal. Substituting U+FFFD would silently rewrite the
    // source's text, and a lie in the record is worse than an undecoded reference.
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return reference;
    return String.fromCodePoint(code);
  }
  return PREDEFINED_ENTITIES[body] ?? reference;
}

/**
 * Decodes the five predefined XML entities and numeric character references, and nothing else.
 * There is no DOCTYPE handling and no custom-entity table, so an undefined reference such as
 * `&lol4;` is returned verbatim instead of being expanded.
 */
export function decodeXmlEntities(raw: string): string {
  return raw.replace(ENTITY_REFERENCE, decodeReference);
}

/**
 * Decode first, then strip. The order matters: a real source publishes
 * `&lt;a href=&#34;…&#34;&gt;查看全文&lt;/a&gt;`, and stripping before decoding would leave the
 * literal `<a href="…">` in the summary because the tags are still escaped at that point.
 */
export function toPlainText(raw: string, limit: number = SUMMARY_LIMIT): string {
  const text = decodeXmlEntities(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A tag carrying attributes becomes `{#text, @_attr}`, a repeated tag becomes an array, and a
 * whitespace-only tag with attributes has no `#text` key at all. Every read goes through here so
 * those three shapes cannot leak an object into a string field.
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value !== null && typeof value === 'object') {
    return textOf((value as Record<string, unknown>)['#text']);
  }
  return '';
}

function asNode(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Prefers an exact unprefixed match and only then falls back to the local name. That ordering is
 * what keeps `dc:date` readable while stopping an RSS item's `<atom:link rel="self">` from being
 * mistaken for its `<link>`.
 */
function child(node: Record<string, unknown>, name: string): unknown {
  const exact = node[name];
  if (exact !== undefined) return exact;
  for (const key of Object.keys(node)) {
    if (key === '#text' || key.startsWith('@_')) continue;
    if (localName(key) === name) return node[key];
  }
  return undefined;
}

function firstText(node: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const text = textOf(child(node, name)).trim();
    if (text) return text;
  }
  return '';
}

/**
 * A link or a native id is XML text, so a real `&` in a query string reaches the parser as the
 * mandatory `&amp;` escape. Decoding is what makes the value the URL it names: without it,
 * `contentRef` carries a literal `&amp;` and the host surfaces a link that does not resolve.
 */
function referenceText(value: unknown): string {
  return decodeXmlEntities(textOf(value)).trim();
}

/** `<link>` text form, which is not Atom-legal but shows up in the wild. */
function selectAtomLink(value: unknown): string {
  const links = Array.isArray(value) ? value : [value];
  let unqualified = '';
  for (const entry of links) {
    const node = asNode(entry);
    if (!node) {
      const text = textOf(entry).trim();
      if (text && !unqualified) unqualified = text;
      continue;
    }
    const href = typeof node['@_href'] === 'string' ? node['@_href'].trim() : '';
    if (!href) continue;
    const rel = typeof node['@_rel'] === 'string' ? node['@_rel'].trim().toLowerCase() : '';
    if (rel === 'alternate') return href;
    // A missing `rel` defaults to `alternate` per RFC 4287. Anything else named — `self`, `hub`,
    // `enclosure`, `edit`, `replies` — points at something that is not the entry's own page.
    if (rel === '' && !unqualified) unqualified = href;
  }
  return unqualified;
}

/**
 * Skips a BOM, whitespace, the XML declaration, processing instructions, comments and DOCTYPE.
 * DOCTYPE is scanned by hand because its internal subset contains `>` characters that would
 * otherwise terminate the skip early.
 */
function skipDeclaration(text: string, start: number): number {
  let cursor = start + 2;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '[') {
      const close = text.indexOf(']', cursor);
      if (close < 0) return -1;
      cursor = close + 1;
      continue;
    }
    if (char === '>') return cursor + 1;
    cursor++;
  }
  return -1;
}

function detectRootName(text: string): string | null {
  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === ' ' || char === '\t' || char === '\n') { cursor++; continue; }
    if (char !== '<') return null;
    if (text.startsWith('<?', cursor)) {
      const end = text.indexOf('?>', cursor);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<!', cursor)) {
      cursor = skipDeclaration(text, cursor);
      if (cursor < 0) return null;
      continue;
    }
    return /^<([^\s/>]+)/.exec(text.slice(cursor, cursor + 256))?.[1] ?? null;
  }
  return null;
}

function notAFeed(reason: string): ProtocolError {
  return new ProtocolError('EXTERNAL_FAILURE', `The response is not a usable feed: ${reason}`, false);
}

/**
 * Parses an RSS 2.0 or Atom document.
 *
 * Three independent checks run in a fixed order, because each catches something the others miss:
 * the root-element check rejects a 200 response that is really an HTML anti-bot page (a real case:
 * `36kr.com/feed` answers 200 with `<!DOCTYPE html>`), `XMLValidator` rejects malformed XML, and
 * the parse itself is wrapped because it throws on external entities and on `__proto__` tags.
 * Root detection must come first — that HTML body also fails validation with
 * `InvalidChar: char '&' is not expected`, which would misreport "not a feed" as "broken XML".
 */
export function parseFeedDocument(raw: string): FeedDocument {
  if (raw.length > MAX_BODY_CHARS) {
    throw new ProtocolError('EXTERNAL_FAILURE', `Feed body exceeds the ${MAX_BODY_CHARS} character limit`, false);
  }
  // XML 1.0 §2.11 requires CRLF and lone CR to be normalized to LF before parsing. Doing it here
  // as well means a CRLF checkout of a fixture parses identically to its LF original.
  const body = raw.replace(/\r\n?/g, '\n');

  const rootName = detectRootName(body);
  if (rootName === null || !FEED_ROOTS.has(localName(rootName))) {
    throw notAFeed(rootName === null ? 'no root element found' : `root element is <${localName(rootName)}>, not <rss> or <feed>`);
  }

  const validity = XMLValidator.validate(body);
  if (validity !== true) {
    // `msg` is deliberately not reported: it quotes the offending source text, which would put
    // untrusted feed content into an error message that can reach a log or a UI.
    throw new ProtocolError('EXTERNAL_FAILURE', `Feed XML is not well formed (${validity.err.code} at line ${validity.err.line}, column ${validity.err.col})`, false);
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch (error) {
    // Reached for external entities and for dangerous tag names. The parser's own message is kept
    // because it names the mechanism, not the document, but it is still not fed source text.
    throw new ProtocolError('EXTERNAL_FAILURE', `Feed XML was rejected by the parser: ${error instanceof Error ? error.message : 'unknown reason'}`, false);
  }

  const root = asNode(parsed);
  if (!root) throw notAFeed('the document did not parse to an element tree');
  const rootKey = Object.keys(root).find(key => FEED_ROOTS.has(localName(key)));
  if (rootKey === undefined) throw notAFeed('no <rss> or <feed> element in the parsed document');
  const feedNode = asNode(root[rootKey]);
  if (!feedNode) throw notAFeed('the root element is empty');

  return localName(rootKey) === 'rss' ? readRss(feedNode) : readAtom(feedNode);
}

function readRss(feedNode: Record<string, unknown>): FeedDocument {
  const channelValue = child(feedNode, 'channel');
  // Throwing rather than returning zero entries: an <rss> without a <channel> is not a feed, and
  // reporting "nothing new" for it would be a silent degradation the host cannot distinguish from
  // a genuine 304. A present but empty <channel/> is a legitimately empty feed, so it is kept.
  if (channelValue === undefined) throw notAFeed('the RSS document has no <channel>');
  const channel = asNode(channelValue) ?? {};
  const items = child(channel, 'item');
  const list = Array.isArray(items) ? items : items === undefined ? [] : [items];

  const entries: FeedEntryText[] = [];
  list.forEach((item, index) => {
    // An empty <item/> parses to '' rather than an object. It is kept as an all-empty entry so the
    // service reports it in skipped[] by position; dropping it here would hide a real item.
    const node = asNode(item) ?? {};
    entries.push({
      index,
      title: textOf(child(node, 'title')).trim(),
      link: referenceText(child(node, 'link')),
      nativeId: referenceText(child(node, 'guid')),
      publishedText: firstText(node, ['pubDate', 'date']),
      updatedText: '',
      bodyText: firstText(node, ['description', 'encoded']),
    });
  });

  return {
    kind: 'rss',
    title: textOf(child(channel, 'title')).trim(),
    buildText: firstText(channel, ['lastBuildDate', 'pubDate', 'date']),
    entries,
  };
}

function readAtom(feedNode: Record<string, unknown>): FeedDocument {
  const list = child(feedNode, 'entry');
  const nodes = Array.isArray(list) ? list : list === undefined ? [] : [list];

  const entries: FeedEntryText[] = [];
  nodes.forEach((entry, index) => {
    const node = asNode(entry) ?? {};
    entries.push({
      index,
      title: textOf(child(node, 'title')).trim(),
      link: referenceText(selectAtomLink(child(node, 'link'))),
      nativeId: referenceText(child(node, 'id')),
      publishedText: textOf(child(node, 'published')).trim(),
      updatedText: textOf(child(node, 'updated')).trim(),
      bodyText: firstText(node, ['summary', 'content']),
    });
  });

  return {
    kind: 'atom',
    title: textOf(child(feedNode, 'title')).trim(),
    buildText: firstText(feedNode, ['updated', 'published', 'modified']),
    entries,
  };
}
