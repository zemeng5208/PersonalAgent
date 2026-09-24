import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateToolValue} from '@personal-agent/contracts';
import {createSystemObservationTool, SYSTEM_OBSERVATION_SCOPE} from '../dist/index.js';

// Direct provider read only. It does not exercise production capability discovery or Policy.
const outputArgument = process.argv[2];
if (process.platform !== 'win32') {
  process.stderr.write('UNSUPPORTED_PLATFORM: run in a Windows standard-user session\n');
  process.exitCode = 1;
} else if (!outputArgument || process.argv.length !== 3) {
  process.stderr.write('INVALID_ARGUMENT: provide one new evidence JSON output path\n');
  process.exitCode = 1;
} else {
  try {
    const tool = createSystemObservationTool();
    const observation = await tool.execute({}, {
      taskId: 'manual-provider-read',
      runId: 'manual-provider-read',
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 10_000).toISOString(),
      scopes: [SYSTEM_OBSERVATION_SCOPE],
    });
    validateToolValue(tool.descriptor.outputSchema, observation);
    if (observation.source !== 'node:os') throw new Error('Unexpected observation source');

    const evidence = {
      evidenceKind: 'direct_provider_read_only',
      platform: 'win32',
      nodeVersion: process.version,
      tool: `${tool.descriptor.name}@${tool.descriptor.version}`,
      source: observation.source,
      capturedAt: observation.capturedAt,
      sampledFrom: observation.sampledFrom,
      sampledUntil: observation.sampledUntil,
      requestedSampleWindowMs: observation.requestedSampleWindowMs,
      actualSampleWindowMs: observation.actualSampleWindowMs,
      schemaValid: true,
      aggregateValuesPresent: true,
      unavailable: observation.unavailable,
      productionAuthorizationVerified: false,
      agentArtsVerified: false,
    };
    await writeFile(resolve(outputArgument), `${JSON.stringify(evidence, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    process.stdout.write('PASS: redacted direct-provider evidence saved\n');
  } catch (error) {
    // Never print probe exceptions, output paths, or aggregate readings.
    const code = error && typeof error === 'object' &&
      ['CANCELLED', 'TIMEOUT', 'EXTERNAL_FAILURE'].includes(error.code) ? error.code : 'EVIDENCE_CAPTURE_FAILED';
    process.stderr.write(`${code}: no successful evidence was saved\n`);
    process.exitCode = 1;
  }
}
