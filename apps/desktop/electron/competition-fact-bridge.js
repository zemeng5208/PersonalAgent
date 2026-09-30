import path from 'node:path';

const SOURCE_KEY = Object.freeze({vaultId: 'competition-synthetic',
  path: 'meeting.json', factId: 'competition/meeting/mvp-meeting/start'});
const BASELINE_TIME = '2026-09-25T00:00:00.000Z';
const UPDATE_TIME = '2026-09-25T01:00:00.000Z';
const VALID_UNTIL = '2099-01-01T00:00:00.000Z';

function context() {
  return {deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal};
}

function record(host, source, observedAt, expectedFactRevision) {
  return host.recordPublicSource({...SOURCE_KEY,
    sourceRevision: source.sourceRevision,
    line: 1,
    summary: `Synthetic meeting ${source.meeting.meetingId} starts at ${source.meeting.start} ${source.meeting.timezone}`,
    observedAt,
    validFrom: BASELINE_TIME,
    validUntil: VALID_UNTIL,
    expectedFactRevision,
  }, context());
}

/** Trusted Desktop-only source projection; cloud and Renderer content are never accepted here. */
export function createDesktopCompetitionFactBridge({application, catalog, runtimePath, userNamespace}) {
  if (!application || !catalog || !path.isAbsolute(runtimePath)
    || typeof userNamespace !== 'string' || !userNamespace.trim()) {
    throw Error('Competition Fact bridge configuration is invalid');
  }
  const host = application.createCompetitionFactHost({
    memoryPath: path.join(path.dirname(runtimePath), 'competition-memory.sqlite'),
    memoryNamespace: `${userNamespace}:competition-public`,
    graphNamespace: `${userNamespace}:competition-graph`,
    consumerKey: 'desktop-synthetic-meeting-v1',
  });
  let closed = false;
  return Object.freeze({
    async recover() {
      if (closed) throw Error('Competition Fact bridge is closed');
      const baseline = await catalog.readSyntheticMeetingBaseline();
      const update = await catalog.readSyntheticMeetingSource();
      if (baseline.meeting.meetingId !== update.meeting.meetingId
        || baseline.meeting.revision !== 1 || update.meeting.revision !== 2
        || baseline.meeting.start !== '15:00' || update.meeting.start !== '17:00') {
        throw Error('Synthetic meeting source is inconsistent');
      }
      let revision = host.readPublicSourceHead(SOURCE_KEY);
      if (revision === null || revision === 1) {
        record(host, baseline, BASELINE_TIME, revision);
        revision = host.readPublicSourceHead(SOURCE_KEY);
      }
      if (revision !== 1 && revision !== 2) throw Error('Synthetic meeting Fact revision is unexpected');
      record(host, update, UPDATE_TIME, 1);
      const drained = await host.drain({limit: 10, maxBatches: 4, ...context()});
      if (!drained.atWatermark) throw Error('Competition Fact projection has not reached its watermark');
      const impacts = host.processImpacts({at: new Date().toISOString(), limit: 10, ...context()});
      return Object.freeze({factRevision: host.readPublicSourceHead(SOURCE_KEY),
        projected: drained.batches, completedImpacts: impacts.length});
    },
    close() { if (!closed) { closed = true; host.close(); } },
  });
}
