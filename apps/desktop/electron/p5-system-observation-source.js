function text(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function sampleFrom(readback, taskId) {
  if (!readback || readback.taskId !== taskId || readback.source !== 'node:os'
    || !text(readback.timestamp, 32) || !Number.isFinite(Date.parse(readback.timestamp))
    || !Number.isFinite(readback.cpuPercent) || readback.cpuPercent < 0 || readback.cpuPercent > 100
    || !Number.isFinite(readback.memoryPercent) || readback.memoryPercent < 0 || readback.memoryPercent > 100
    || !Number.isSafeInteger(readback.samplingIntervalMs) || readback.samplingIntervalMs < 1000
    || !Array.isArray(readback.evidenceRefs) || readback.evidenceRefs.length === 0 || readback.evidenceRefs.length > 256
    || !readback.evidenceRefs.every(ref => text(ref, 256))) return undefined;
  return {
    source: 'node:os', timestamp: readback.timestamp,
    cpuPercent: readback.cpuPercent, memoryPercent: readback.memoryPercent,
    samplingIntervalMs: readback.samplingIntervalMs,
    taskId, evidenceRefs: [...readback.evidenceRefs],
  };
}

function sameProvenance(left, right) {
  return left.taskId === right.taskId && left.source === right.source && left.timestamp === right.timestamp
    && left.cpuPercent === right.cpuPercent && left.memoryPercent === right.memoryPercent
    && left.samplingIntervalMs === right.samplingIntervalMs
    && left.evidenceRefs.length === right.evidenceRefs.length
    && left.evidenceRefs.every((ref, index) => ref === right.evidenceRefs[index]);
}

/** A narrow adapter over the existing Runtime event pump and consent-bound readback. */
export function createP5SystemObservationSource({application, maxRecent = 256} = {}) {
  if (typeof application?.readCurrentSystemObservationSample !== 'function'
    || !Number.isSafeInteger(maxRecent) || maxRecent < 1 || maxRecent > 4096) {
    throw new Error('Invalid P5 system observation source');
  }
  const listeners = new Set();
  const publishedTasks = new Set();
  const recent = new Map();
  let disposed = false;
  const keyFor = value => JSON.stringify([value.source, value.timestamp]);
  const currentReadback = taskId => {
    try { return application.readCurrentSystemObservationSample(taskId); }
    catch { return undefined; }
  };

  return Object.freeze({
    subscribe(listener) {
      if (disposed || typeof listener !== 'function') throw new Error('P5 system observation source is unavailable');
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },

    publishCompletedTask(taskId) {
      if (disposed || !text(taskId, 256) || publishedTasks.has(taskId)) return false;
      const sample = sampleFrom(currentReadback(taskId), taskId);
      if (!sample) return false;
      publishedTasks.add(taskId);
      recent.set(keyFor(sample), structuredClone(sample));
      while (recent.size > maxRecent) recent.delete(recent.keys().next().value);
      while (publishedTasks.size > maxRecent * 2) publishedTasks.delete(publishedTasks.values().next().value);
      for (const listener of listeners) {
        try { listener(structuredClone(sample)); } catch { /* One consumer cannot block Runtime event delivery. */ }
      }
      return true;
    },

    readCurrentProvenance({source, timestamp} = {}) {
      if (disposed || !text(source, 64) || !text(timestamp, 32)) return undefined;
      const known = recent.get(keyFor({source, timestamp}));
      if (!known) return undefined;
      const current = sampleFrom(currentReadback(known.taskId), known.taskId);
      return current && sameProvenance(known, current) ? structuredClone(known) : undefined;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      recent.clear();
      publishedTasks.clear();
    },
  });
}
