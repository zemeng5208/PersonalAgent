import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {parseFeedDocument, parseFeedDate, decodeXmlEntities, toPlainText, MAX_BODY_CHARS} from '../dist/index.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const DATE_CASES = [
  ['Sat, 05 Sep 2026 16:00:01 +0800', '2026-09-05T08:00:01.000Z'],
  ['Fri, 04 Sep 2026 22:00:00 -0500', '2026-09-05T03:00:00.000Z'],
  ['Fri, 04 Sep 2026 12:00:00 GMT', '2026-09-04T12:00:00.000Z'],
  ['Fri, 04 Sep 2026 12:00:00 EST', '2026-09-04T17:00:00.000Z'],
  ['Fri, 04 Sep 2026 12:00:00 EDT', '2026-09-04T16:00:00.000Z'],
  ['Fri, 04 Sep 2026 12:00:00 UTC', '2026-09-04T12:00:00.000Z'],
  ['2026-09-03T23:59:05Z', '2026-09-03T23:59:05.000Z'],
  ['2026-09-03T23:59:05.123Z', '2026-09-03T23:59:05.123Z'],
  ['2026-09-04T15:59:05+08:00', '2026-09-04T07:59:05.000Z'],
  ['2026-09-04T15:59:05+0800', '2026-09-04T07:59:05.000Z'],
  ['Sun, 06 Sep 2026 01:30:00 +0800', '2026-09-05T17:30:00.000Z'],
  ['2026-02-28T23:00:00-05:00', '2026-03-01T04:00:00.000Z'],
];

const DATE_REJECTIONS = [
  ['Fri, 04 Sep 26 12:00:00 GMT', 'two-digit year: the century would be a guess'],
  ['not a date at all', 'not a date'],
  ['2026-09-04T15:59:05', 'RFC 3339 with no offset: UTC and local time are both guesses'],
  ['Fri, 04 Sep 2026 12:00:00', 'RFC 822 with no zone'],
  ['Fri, 04 Sep 2026 12:00:00 MSK', 'zone this module does not define'],
  ['Fri, 04 Sep 2026 12:00:00 A', 'military zone, ambiguous by design'],
  ['2026-02-30T12:00:00Z', 'February 30 would roll into March'],
  ['2026-09-04T24:00:00Z', 'hour 24'],
  ['2026-09-04T12:60:00Z', 'minute 60'],
  ['2026-06-30T23:59:60Z', 'leap second has no JS Date representation'],
  ['2026-13-04T12:00:00Z', 'month 13'],
  ['9999-12-31T23:59:59-14:00', 'the offset pushes the UTC instant past year 9999'],
  ['', 'empty'],
  ['   ', 'whitespace only'],
];

test('parses the timestamp spellings real feeds actually emit', () => {
  for (const [input, expected] of DATE_CASES) {
    assert.equal(parseFeedDate(input), expected, `failed on ${JSON.stringify(input)}`);
  }
});

test('returns null rather than guessing on an unusable timestamp', () => {
  for (const [input, why] of DATE_REJECTIONS) {
    assert.equal(parseFeedDate(input), null, `should have rejected (${why}): ${JSON.stringify(input)}`);
  }
  assert.equal(parseFeedDate(undefined), null);
  assert.equal(parseFeedDate(null), null);
  assert.equal(parseFeedDate(1757000000000), null);
});

test('every date expectation pinned in date-formats.xml holds, including the two that must degrade', () => {
  const doc = parseFeedDocument(fixture('date-formats.xml'));
  assert.equal(doc.kind, 'rss');
  assert.equal(doc.entries.length, 11);
  assert.equal(parseFeedDate(doc.buildText), '2026-09-05T10:00:00.000Z');
  // The expected UTC value is written into each title by the fixture author.
  for (const [index, expected] of DATE_CASES.slice(0, 9).entries()) {
    const entry = doc.entries[index];
    assert.equal(parseFeedDate(entry.publishedText), expected[1], `entry ${index}`);
    assert.match(entry.title, /^期望 /);
  }
  for (const index of [9, 10]) {
    assert.equal(parseFeedDate(doc.entries[index].publishedText), null, `entry ${index} must be unparseable`);
  }
});

test('reads the real Atom source: tag: ids, and published differs from updated', () => {
  const doc = parseFeedDocument(fixture('ruanyifeng-atom.xml'));
  assert.equal(doc.kind, 'atom');
  assert.equal(doc.entries.length, 3);
  assert.equal(doc.buildText, '2026-09-05T14:48:27Z');
  for (const entry of doc.entries) {
    assert.match(entry.nativeId, /^tag:www\.ruanyifeng\.com,2026:\/blog\/\/1\.\d+$/);
    assert.match(entry.link, /^http:\/\/www\.ruanyifeng\.com\/blog\//);
    assert.notEqual(entry.publishedText, '', 'Atom <published> must be read');
    assert.notEqual(entry.updatedText, '', 'Atom <updated> must be read separately');
  }
  assert.notEqual(doc.entries[0].publishedText, doc.entries[0].updatedText);
  assert.equal(parseFeedDate(doc.entries[0].publishedText), '2026-09-03T23:59:05.000Z');
  // The real content is CDATA-wrapped HTML with several sibling CDATA sections.
  assert.match(toPlainText(doc.entries[0].bodyText), /每周值得分享的科技内容/);
  assert.equal(toPlainText(doc.entries[0].bodyText).includes('<'), false, 'no tag may survive into plain text');
});

test('reads the real RSS source: no guid on any item, and a channel-level pubDate', () => {
  const doc = parseFeedDocument(fixture('sspai-rss.xml'));
  assert.equal(doc.kind, 'rss');
  assert.equal(doc.entries.length, 5);
  for (const entry of doc.entries) {
    assert.equal(entry.nativeId, '', 'this real source publishes no <guid> at all');
    assert.match(entry.link, /^https:\/\/sspai\.com\/post\/\d+$/);
    assert.match(entry.publishedText, /\+0800$/);
    assert.equal(entry.updatedText, '', 'RSS 2.0 has no per-item update time');
  }
  // No lastBuildDate, but the channel does carry a pubDate, so a dateless item could still fall
  // back to a labelled feed-level time instead of being skipped.
  assert.equal(doc.buildText, 'Sat, 05 Sep 2026 16:00:01 +0800');
  assert.equal(parseFeedDate(doc.buildText), '2026-09-05T08:00:01.000Z');
  // The trailing <atom:link ref="self"> must not be mistaken for the channel's own <link>.
  assert.equal(doc.title, '少数派');
});

test('rejects a 200 response whose body is an HTML anti-bot page', () => {
  const html = fixture('html-body-not-a-feed.html');
  let error;
  try { parseFeedDocument(html); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EXTERNAL_FAILURE');
  assert.equal(error.retryable, false, 'bot filtering does not clear up on retry');
  assert.match(error.message, /root element is <html>/);
  assert.equal(error.message.includes('<!DOCTYPE'), false, 'must not echo the source document');
});

test('rejects malformed XML with position only, never quoting the source', () => {
  let error;
  try { parseFeedDocument(fixture('malformed.xml')); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EXTERNAL_FAILURE');
  assert.equal(error.retryable, false);
  assert.match(error.message, /InvalidTag at line \d+, column \d+/);
  // The validator's own `msg` can quote the document, so only code and position are reported.
  for (const forbidden of ['unclosed', 'example.com', '畸形源', '未闭合']) {
    assert.equal(error.message.includes(forbidden), false, `error message leaked ${JSON.stringify(forbidden)}`);
  }
});

test('never expands a DOCTYPE-declared entity, defined or not', () => {
  const started = Date.now();
  const doc = parseFeedDocument(fixture('entity-expansion.xml'));
  assert.ok(Date.now() - started < 500, 'entity expansion would take far longer');
  assert.equal(doc.entries.length, 2);
  // Both stay literal: expanding them is exactly what a billion-laughs document asks for.
  assert.equal(doc.entries[0].title, '&lol4;');
  assert.equal(doc.entries[1].title, '&lol8;');
  assert.equal(doc.buildText, '');
});

test('refuses an external entity instead of reading from the filesystem', () => {
  let error;
  try { parseFeedDocument(fixture('external-entity.xml')); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EXTERNAL_FAILURE');
  assert.equal(error.retryable, false);
  assert.match(error.message, /[Ee]xternal entit/);
});

test('refuses a __proto__ tag without leaking the parser internals', () => {
  let error;
  try { parseFeedDocument('<rss><channel><__proto__>x</__proto__><item><title>t</title></item></channel></rss>'); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EXTERNAL_FAILURE');
  assert.match(error.message, /__proto__/);
  assert.equal(/[A-Za-z]:\\|\/home\/|\/Users\//.test(error.message), false, 'must not leak a filesystem path');
});

test('caps the body size', () => {
  const body = `<rss><channel><title>${'x'.repeat(MAX_BODY_CHARS + 1)}</title></channel></rss>`;
  let error;
  try { parseFeedDocument(body); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EXTERNAL_FAILURE');
  assert.equal(error.retryable, false);
});

test('rejects an RSS document with no channel, and accepts a present but empty one', () => {
  assert.throws(() => parseFeedDocument('<rss version="2.0"/>'), {code: 'EXTERNAL_FAILURE'});
  const empty = parseFeedDocument('<rss version="2.0"><channel/></rss>');
  assert.equal(empty.entries.length, 0);
});

test('a CRLF or lone-CR checkout parses identically to the LF original', () => {
  const lf = fixture('ruanyifeng-atom.xml');
  const shape = doc => JSON.stringify(doc);
  assert.equal(shape(parseFeedDocument(lf.replace(/\n/g, '\r\n'))), shape(parseFeedDocument(lf)));
  assert.equal(shape(parseFeedDocument(lf.replace(/\n/g, '\r'))), shape(parseFeedDocument(lf)));
});

test('decodes only the five predefined entities and numeric references', () => {
  assert.equal(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.equal(decodeXmlEntities('&#34;&#65;&#x42;&#x43;'), '"ABC');
  assert.equal(decodeXmlEntities('中文'), '中文');
  // Unknown entities stay literal: there is no DTD, so their meaning is genuinely unknown.
  assert.equal(decodeXmlEntities('&lol4;&nbsp;&custom;'), '&lol4;&nbsp;&custom;');
  // Unrepresentable code points stay literal rather than becoming U+FFFD.
  assert.equal(decodeXmlEntities('&#xD800;&#x110000;&#9999999;'), '&#xD800;&#x110000;&#9999999;');
  assert.equal(decodeXmlEntities('&'), '&');
  assert.equal(decodeXmlEntities(''), '');
});

test('decodes entities before stripping tags, and truncates the result', () => {
  // The exact shape sspai publishes. Stripping first would leave the literal tag in the summary
  // because it is still escaped at that point.
  assert.equal(toPlainText('&lt;a href=&#34;https://sspai.com/post/1&#34;&gt;查看全文&lt;/a&gt;'), '查看全文');
  assert.equal(toPlainText('<p>第一段</p><p>第二段</p>'), '第一段 第二段', 'tags must not glue words together');
  assert.equal(toPlainText('  a \n\n b  '), 'a b');
  assert.equal(toPlainText('x'.repeat(400), 280).length, 280);
  assert.equal(toPlainText('x'.repeat(400), 280).endsWith('…'), true);
  assert.equal(toPlainText('short'), 'short');
  assert.equal(toPlainText(''), '');
});

test('selects the Atom link by rel and refuses to treat an enclosure as the entry page', () => {
  const doc = parseFeedDocument(fixture('atom-fallbacks.xml'));
  assert.equal(doc.entries.length, 5);
  assert.equal(doc.entries[0].link, 'https://example.com/atom/both', 'rel="alternate" wins over other rels');
  assert.equal(doc.entries[2].link, 'https://example.com/atom/no-id');
  assert.equal(doc.entries[2].nativeId, '', 'an entry with no <id> must fall back to the link');
  assert.equal(doc.entries[4].link, '', 'an enclosure is an attachment, not the entry page');
  assert.equal(doc.entries[1].publishedText, '');
  assert.notEqual(doc.entries[1].updatedText, '');
});

test('reads dc:date, keeps a backfilled entry, and preserves two same-instant entries', () => {
  const doc = parseFeedDocument(fixture('dc-namespace-rss.xml'));
  assert.equal(doc.entries.length, 6);
  assert.equal(parseFeedDate(doc.entries[0].publishedText), '2026-09-05T01:30:00.000Z');
  // Backfilled: published earlier than its neighbours but appearing later in the document.
  assert.equal(parseFeedDate(doc.entries[1].publishedText), '2026-09-01T00:00:00.000Z');
  assert.equal(doc.entries[2].publishedText, '', 'an entry with no own date stays empty at this layer');
  assert.equal(doc.entries[4].publishedText, doc.entries[5].publishedText);
  assert.notEqual(doc.entries[4].link, doc.entries[5].link);
  assert.equal(doc.entries[1].bodyText.includes('补发的说明文字'), true, 'CDATA and text must merge');
});

test('counts every item, including ones that are empty or carry no identifier', () => {
  const variants = parseFeedDocument(fixture('rss-guid-variants.xml'));
  assert.equal(variants.entries.length, 6);
  assert.equal(variants.entries[0].nativeId, 'https://example.com/keys/permalink');
  assert.match(variants.entries[1].nativeId, /^urn:uuid:/);
  assert.equal(variants.entries[2].nativeId, '');
  assert.equal(variants.entries[4].nativeId, '', 'a whitespace-only guid is not an identifier');
  // The trailing near-empty item is still present at its document position.
  assert.equal(variants.entries[5].index, 5);
  assert.deepEqual([variants.entries[5].title, variants.entries[5].link, variants.entries[5].nativeId], ['', '', '']);

  const dateless = parseFeedDocument(fixture('no-key-no-date.xml'));
  assert.equal(dateless.entries.length, 3);
  assert.equal(dateless.buildText, '', 'this channel deliberately provides no feed-level time');
  assert.equal(dateless.entries[1].index, 1);
  assert.deepEqual([dateless.entries[1].title, dateless.entries[1].bodyText], ['', '']);
  assert.equal(dateless.entries[2].nativeId, 'skip-normal');
});

test('decodes entity escapes in a link or id, which are URLs and not prose', () => {
  // Well-formed XML has to write a real query separator as `&amp;`. Leaving it encoded would put a
  // literal `&amp;` into `contentRef`, and the host would surface a link that does not resolve.
  const rss = parseFeedDocument([
    '<rss version="2.0"><channel><title>t</title><item>',
    '<title>带查询参数的链接</title>',
    '<link>https://example.com/p?a=1&amp;b=2</link>',
    '<guid>urn:uuid:1&amp;2</guid>',
    '<pubDate>Sat, 05 Sep 2026 10:00:00 +0000</pubDate>',
    '</item></channel></rss>',
  ].join(''));
  assert.equal(rss.entries[0].link, 'https://example.com/p?a=1&b=2');
  assert.equal(rss.entries[0].nativeId, 'urn:uuid:1&2');

  // The Atom form carries the URL in an attribute, which is escaped the same way.
  const atom = parseFeedDocument([
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><entry>',
    '<id>tag:example.com,2026:a&amp;b</id>',
    '<link rel="alternate" href="https://example.com/e?a=1&amp;b=2"/>',
    '<updated>2026-09-05T10:00:00Z</updated>',
    '</entry></feed>',
  ].join(''));
  assert.equal(atom.entries[0].link, 'https://example.com/e?a=1&b=2');
  assert.equal(atom.entries[0].nativeId, 'tag:example.com,2026:a&b');
});
