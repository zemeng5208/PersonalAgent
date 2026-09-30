const competitionFooter = /\n\[profile=huawei_ict_agentarts; verification=(mock|unverified)\]$/;

// The host supplies provenance from the original Runtime profile and loop.
// Without it, including for ordinary messages, all source text is preserved.
export function resultMetadata(value, provenance) {
  if (typeof value !== 'string' || provenance?.profile !== 'huawei_ict_agentarts') return undefined;
  const match = competitionFooter.exec(value);
  return match ? {profile: 'huawei_ict_agentarts', verification: match[1]} : undefined;
}

export function resultText(value, provenance) {
  if (typeof value !== 'string') return '';
  return resultMetadata(value, provenance) ? value.replace(competitionFooter, '') : value;
}
