/** Redacts common credential forms. This is not a general DLP classifier. */
export function redactGitHubText(value: string, secrets: readonly string[] = []): string {
  let text = value.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[REDACTED]@');
  for (const secret of secrets) if (secret.length) text = text.split(secret).join('[REDACTED]');
  return text;
}
export function redactValue<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactGitHubText(value, secrets) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(token|password|secret|authorization)$/i.test(key) ? '[REDACTED]' : redactValue(item, secrets)])) as T;
  return value;
}
