/**
 * Keeps configured feed URLs out of anything this package emits.
 *
 * A subscription URL may carry a token, and it leaves the module through two very different paths:
 * error messages (where Node puts the full URL in `cause`) and text derived from the document (where
 * a hostile source could echo the request URL, or just the token, back as an item link). Both need
 * redaction, but with different aggression — an error message loses nothing by having every URL
 * swept out, while `contentRef` would be destroyed by that, since item links are legitimate public
 * content that a digest is expected to follow.
 */

/** Shorter values are too likely to collide with ordinary words to be worth removing. */
const MIN_NEEDLE_LENGTH = 8;

/** Substrings of a configured URL that must never appear in output. */
export function secretNeedles(url: URL): string[] {
  const needles = [url.href, url.search, url.search.slice(1)];
  // A source that echoes only the token value, without the `?name=` prefix, still leaks it.
  for (const value of url.searchParams.values()) needles.push(value);
  const unique = new Set(needles.filter(value => value.length >= MIN_NEEDLE_LENGTH));
  return [...unique].sort((a, b) => b.length - a.length);
}

function applyNeedles(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) out = out.split(needle).join('<redacted>');
  return out;
}

/** For text derived from the document. Surgical: only the configured URL and its credentials. */
export function makeContentRedactor(url: URL): (text: string) => string {
  const needles = secretNeedles(url);
  if (needles.length === 0) return text => text;
  return text => applyNeedles(text, needles);
}

/**
 * For error messages. Also sweeps any other absolute URL, because a redirect target or a resolver
 * error can name a host that was never configured, and neutralizes credential-looking query pairs.
 */
export function makeErrorRedactor(url: URL | null): (text: string) => string {
  const needles = url === null ? [] : secretNeedles(url);
  const hosts = url === null ? [] : [...new Set([url.host, url.hostname])].filter(host => host !== '');
  return (text) => {
    const swept = applyNeedles(text, needles)
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()\[\]]+/gi, '<redacted-url>');
    const neutralized = swept.replace(/([?&/#][A-Za-z0-9_.-]*(?:token|key|secret|passw|auth|signature|sig|apikey|access)[A-Za-z0-9_.-]*=)[^\s"'&<>]+/gi, '$1<redacted>');
    return scrubHosts(neutralized, hosts);
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Node reports a DNS failure as a bare host with no scheme (`connect ENOTFOUND private.example.com`),
 * which neither the full-href needle nor the absolute-URL sweep above matches. The host is still a
 * fragment of the configured URL, so it goes too — but only where it stands alone, because a plain
 * substring replacement would corrupt unrelated words that happen to contain it.
 */
function scrubHosts(text: string, hosts: readonly string[]): string {
  let out = text;
  for (const host of hosts) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?![\\w.-])`, 'gi'), '<redacted-host>');
  }
  return out;
}
