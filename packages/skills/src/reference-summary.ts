/** The same pure excerpt is used by the local worker and its PUBLIC projection. */
export function referenceSummary(text:string) {
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  let content=lines.slice(0,2).join(' ').slice(0,480);
  if(/[\uD800-\uDBFF]$/.test(content)) content=content.slice(0,-1);
  return {content,truncated:content!==lines.join(' ')};
}
