const KNOWN_EVENT_NAMES = new Set([
  "task_start",
  "workflow_start",
  "message",
  "workflow_end",
  "task_end",
  "end",
  "error",
  "status"
]);

const FAILURE_MARKERS = new Set([
  "error",
  "failed",
  "failure",
  "cancelled",
  "canceled"
]);

const DATA_FIELDS = [
  "text",
  "answer",
  "index",
  "workflow_name",
  "event",
  "type",
  "status",
  "error_code",
  "code",
  "message"
];

const TOP_LEVEL_FIELDS = ["event", "type", "status", "data"];

export const STRUCTURAL_DIAGNOSTIC_LIMITS = Object.freeze({
  inspectedBytes: 128 * 1024,
  reportedBytes: 1024 * 1024 + 1,
  lineCharacters: 32 * 1024,
  eventPayloadCharacters: 64 * 1024,
  events: 64,
  counters: 4097,
  stringLength: 16 * 1024 + 1,
  attempts: 4
});

function incrementCapped(value) {
  return Math.min(value + 1, STRUCTURAL_DIAGNOSTIC_LIMITS.counters);
}

function addCapped(value, amount, limit) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return value;
  }
  return Math.min(value + amount, limit);
}

function valueType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "object":
      return typeof value;
    case "undefined":
      return "missing";
    default:
      return "other";
  }
}

function fieldShape(owner, field) {
  if (!owner || typeof owner !== "object" || !Object.hasOwn(owner, field)) {
    return { presence: false, type: "missing" };
  }

  const value = owner[field];
  const shape = { presence: true, type: valueType(value) };
  if (typeof value === "string") {
    shape.lengthCapped = Math.min(
      value.length,
      STRUCTURAL_DIAGNOSTIC_LIMITS.stringLength
    );
    shape.overLimit = value.length > STRUCTURAL_DIAGNOSTIC_LIMITS.stringLength;
  }
  if (field === "index") {
    shape.validNonNegativeInteger =
      Number.isSafeInteger(value) && value >= 0;
  }
  return shape;
}

function countUnknownKeys(value, knownFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const known = new Set(knownFields);
  let count = 0;
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      count = incrementCapped(count);
    }
  }
  return count;
}

function hasFailureMarker(value) {
  if (typeof value !== "string") {
    return false;
  }
  return FAILURE_MARKERS.has(value.trim().toLowerCase());
}

function sanitizeEvent(value) {
  const objectValue = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  const eventCandidate = typeof objectValue?.event === "string"
    ? objectValue.event
    : typeof objectValue?.type === "string"
      ? objectValue.type
      : "";
  const eventName = KNOWN_EVENT_NAMES.has(eventCandidate)
    ? eventCandidate
    : "other";

  const summary = {
    name: eventName,
    rootType: valueType(value),
    failureMarker:
      hasFailureMarker(objectValue?.event) ||
      hasFailureMarker(objectValue?.type) ||
      hasFailureMarker(objectValue?.status),
    top: {},
    topUnknownKeyCountCapped: countUnknownKeys(
      objectValue,
      [...TOP_LEVEL_FIELDS, "error_code", "code", "message"]
    ),
    dataType: valueType(objectValue?.data),
    data: {},
    dataUnknownKeyCountCapped: countUnknownKeys(objectValue?.data, DATA_FIELDS)
  };

  for (const field of TOP_LEVEL_FIELDS) {
    summary.top[field] = fieldShape(objectValue, field);
  }
  for (const field of DATA_FIELDS) {
    summary.data[field] = fieldShape(objectValue?.data, field);
  }
  summary.failureMarker =
    summary.failureMarker ||
    hasFailureMarker(objectValue?.data?.event) ||
    hasFailureMarker(objectValue?.data?.type) ||
    hasFailureMarker(objectValue?.data?.status);

  return summary;
}

function createEventAnalyzer(record) {
  let decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let lineOverflow = false;
  let payload = "";
  let payloadOverflow = false;
  let payloadLineCount = 0;
  let finalized = false;

  function addEvent(value) {
    record.eventCountCapped = incrementCapped(record.eventCountCapped);
    if (record.events.length >= STRUCTURAL_DIAGNOSTIC_LIMITS.events) {
      record.eventCountOverLimit = true;
      return;
    }
    record.events.push(sanitizeEvent(value));
  }

  function parseCandidate(candidate) {
    record.framing.jsonCandidatesCapped = incrementCapped(
      record.framing.jsonCandidatesCapped
    );
    try {
      addEvent(JSON.parse(candidate));
      return true;
    } catch {
      record.framing.jsonParseFailuresCapped = incrementCapped(
        record.framing.jsonParseFailuresCapped
      );
      return false;
    }
  }

  function resetPayload() {
    payload = "";
    payloadOverflow = false;
    payloadLineCount = 0;
  }

  function flushPayload() {
    if (payloadLineCount === 0) {
      return;
    }
    if (payloadOverflow) {
      record.inspectionTruncated = true;
      record.framing.truncatedPayloadsCapped = incrementCapped(
        record.framing.truncatedPayloadsCapped
      );
    } else if (payload === "[DONE]") {
      record.framing.doneMarkersCapped = incrementCapped(
        record.framing.doneMarkersCapped
      );
    } else {
      parseCandidate(payload);
    }
    resetPayload();
  }

  function appendPayload(value) {
    if (payloadLineCount > 0 && !payloadOverflow) {
      if (payload.length + 1 <= STRUCTURAL_DIAGNOSTIC_LIMITS.eventPayloadCharacters) {
        payload += "\n";
      } else {
        payloadOverflow = true;
      }
    }
    payloadLineCount = incrementCapped(payloadLineCount);
    if (payloadOverflow) {
      return;
    }
    const remaining =
      STRUCTURAL_DIAGNOSTIC_LIMITS.eventPayloadCharacters - payload.length;
    if (value.length <= remaining) {
      payload += value;
    } else {
      payload += value.slice(0, remaining);
      payloadOverflow = true;
    }
  }

  function handleLine(rawLine) {
    record.framing.linesCapped = incrementCapped(record.framing.linesCapped);
    const current = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (lineOverflow) {
      record.inspectionTruncated = true;
      record.framing.oversizedLinesCapped = incrementCapped(
        record.framing.oversizedLinesCapped
      );
      lineOverflow = false;
      if (payloadLineCount > 0) {
        payloadOverflow = true;
      }
      flushPayload();
      return;
    }
    if (current === "") {
      record.framing.blankLinesCapped = incrementCapped(
        record.framing.blankLinesCapped
      );
      flushPayload();
      return;
    }
    if (current.startsWith(":")) {
      record.framing.commentLinesCapped = incrementCapped(
        record.framing.commentLinesCapped
      );
      return;
    }
    if (!current.startsWith("data:")) {
      record.framing.otherLinesCapped = incrementCapped(
        record.framing.otherLinesCapped
      );
      return;
    }

    record.framing.dataLinesCapped = incrementCapped(
      record.framing.dataLinesCapped
    );
    const data = current.slice(5).replace(/^ /, "");
    if (data === "[DONE]") {
      flushPayload();
      record.framing.doneMarkersCapped = incrementCapped(
        record.framing.doneMarkersCapped
      );
      return;
    }

    // AgentArts has emitted both standard SSE blocks and one-JSON-per-data-line
    // streams. A complete single-line object is recorded immediately; otherwise
    // a bounded block is retained until the next blank line.
    try {
      const parsed = JSON.parse(data);
      flushPayload();
      record.framing.jsonCandidatesCapped = incrementCapped(
        record.framing.jsonCandidatesCapped
      );
      addEvent(parsed);
    } catch {
      appendPayload(data);
    }
  }

  function observeText(text) {
    if (finalized || record.inspectionTruncated) {
      return;
    }
    for (const character of text) {
      if (character === "\n") {
        handleLine(line);
        line = "";
        continue;
      }
      if (line.length < STRUCTURAL_DIAGNOSTIC_LIMITS.lineCharacters) {
        line += character;
      } else {
        lineOverflow = true;
      }
    }
  }

  function observeBytes(bytes) {
    if (finalized || record.inspectionTruncated || record.utf8 === "invalid") {
      return;
    }
    const remaining =
      STRUCTURAL_DIAGNOSTIC_LIMITS.inspectedBytes - record.inspectedByteCount;
    if (remaining <= 0) {
      record.inspectionTruncated = true;
      if (record.utf8 !== "invalid") {
        record.utf8 = "unknown";
      }
      return;
    }
    const inspected = bytes.byteLength <= remaining
      ? bytes
      : bytes.subarray(0, remaining);
    record.inspectedByteCount += inspected.byteLength;
    try {
      observeText(decoder.decode(inspected, { stream: true }));
      record.utf8 = "valid";
    } catch {
      record.utf8 = "invalid";
      decoder = null;
    }
    if (bytes.byteLength > remaining) {
      record.inspectionTruncated = true;
      if (record.utf8 !== "invalid") {
        record.utf8 = "unknown";
      }
    }
  }

  function finish() {
    if (finalized) {
      return;
    }
    if (record.inspectionTruncated || record.utf8 === "invalid") {
      decoder = null;
      line = "";
      resetPayload();
      finalized = true;
      return;
    }
    if (decoder && record.utf8 !== "invalid") {
      try {
        observeText(decoder.decode());
      } catch {
        record.utf8 = "invalid";
      }
    }
    if (line.length > 0 || lineOverflow) {
      handleLine(line);
      line = "";
    }
    flushPayload();
    finalized = true;
  }

  return { observeBytes, finish };
}

function createAttemptRecord() {
  const record = {
    fetchOutcome: "pending",
    status: "unread",
    contentType: "unread",
    bodyKind: "unread",
    bodyOutcome: "unread",
    byteCountCapped: 0,
    byteCountOverLimit: false,
    byteCountMode: "binary_chunks",
    chunkCountCapped: 0,
    chunkCountOverLimit: false,
    inspectedByteCount: 0,
    inspectionTruncated: false,
    utf8: "unknown",
    diagnosticOutcome: "ok",
    eventInspection: "sse_only",
    eventCountCapped: 0,
    eventCountOverLimit: false,
    framing: {
      linesCapped: 0,
      blankLinesCapped: 0,
      commentLinesCapped: 0,
      dataLinesCapped: 0,
      otherLinesCapped: 0,
      doneMarkersCapped: 0,
      jsonCandidatesCapped: 0,
      jsonParseFailuresCapped: 0,
      oversizedLinesCapped: 0,
      truncatedPayloadsCapped: 0
    },
    events: []
  };
  return { record, analyzer: createEventAnalyzer(record) };
}

function observeChunk(attempt, chunk) {
  try {
    attempt.record.chunkCountCapped = incrementCapped(
      attempt.record.chunkCountCapped
    );
    if (attempt.record.chunkCountCapped >= STRUCTURAL_DIAGNOSTIC_LIMITS.counters) {
      attempt.record.chunkCountOverLimit = true;
    }
    if (!(chunk instanceof Uint8Array)) {
      attempt.record.diagnosticOutcome = "unsupported_chunk";
      attempt.record.byteCountMode = "unavailable";
      return;
    }
    attempt.record.byteCountCapped = addCapped(
      attempt.record.byteCountCapped,
      chunk.byteLength,
      STRUCTURAL_DIAGNOSTIC_LIMITS.reportedBytes
    );
    if (
      attempt.record.byteCountCapped >= STRUCTURAL_DIAGNOSTIC_LIMITS.reportedBytes
    ) {
      attempt.record.byteCountOverLimit = true;
    }
    attempt.analyzer.observeBytes(chunk);
  } catch {
    attempt.record.diagnosticOutcome = "internal_failure";
  }
}

function finishAttempt(attempt, outcome) {
  if (attempt.record.bodyOutcome === "unread") {
    attempt.record.bodyOutcome = outcome;
  } else if (outcome === "rejected") {
    attempt.record.bodyOutcome = "rejected";
  }
  try {
    attempt.analyzer.finish();
  } catch {
    attempt.record.diagnosticOutcome = "internal_failure";
  }
}

function classifyContentType(value) {
  if (value === null || value === undefined || value === "") {
    return "missing";
  }
  if (typeof value !== "string") {
    return "other";
  }
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    return "text/event-stream";
  }
  if (mediaType === "application/json") {
    return "application/json";
  }
  return "other";
}

function wrapHeaders(headers, attempt) {
  if (!headers || typeof headers.get !== "function") {
    return headers;
  }
  return new Proxy(headers, {
    get(target, property, receiver) {
      if (property === "get") {
        return (name) => {
          try {
            const value = target.get(name);
            if (typeof name === "string" && name.toLowerCase() === "content-type") {
              attempt.record.contentType = classifyContentType(value);
              if (attempt.record.contentType === "application/json") {
                attempt.record.eventInspection = "json_unparsed";
              }
            }
            return value;
          } catch (error) {
            if (typeof name === "string" && name.toLowerCase() === "content-type") {
              attempt.record.contentType = "unreadable";
            }
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function wrapReader(reader, attempt) {
  return new Proxy(reader, {
    get(target, property, receiver) {
      if (property === "read") {
        return async (...args) => {
          try {
            const result = await target.read(...args);
            if (result?.done) {
              finishAttempt(attempt, "complete");
            } else {
              observeChunk(attempt, result?.value);
            }
            return result;
          } catch (error) {
            finishAttempt(attempt, "rejected");
            throw error;
          }
        };
      }
      if (property === "cancel") {
        return async (...args) => {
          try {
            const result = await target.cancel(...args);
            finishAttempt(attempt, "cancelled");
            return result;
          } catch (error) {
            finishAttempt(attempt, "rejected");
            throw error;
          }
        };
      }
      if (property === "releaseLock") {
        return (...args) => target.releaseLock(...args);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function wrapAsyncIterator(iterator, attempt) {
  const wrapped = {
    async next(...args) {
      try {
        const result = await iterator.next(...args);
        if (result?.done) {
          finishAttempt(attempt, "complete");
        } else {
          observeChunk(attempt, result?.value);
        }
        return result;
      } catch (error) {
        finishAttempt(attempt, "rejected");
        throw error;
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
  if (typeof iterator.return === "function") {
    wrapped.return = async (...args) => {
      try {
        const result = await iterator.return(...args);
        finishAttempt(attempt, "released");
        return result;
      } catch (error) {
        finishAttempt(attempt, "rejected");
        throw error;
      }
    };
  }
  if (typeof iterator.throw === "function") {
    wrapped.throw = async (...args) => {
      try {
        return await iterator.throw(...args);
      } catch (error) {
        finishAttempt(attempt, "rejected");
        throw error;
      }
    };
  }
  return wrapped;
}

function wrapBody(body, attempt) {
  if (body === null || body === undefined) {
    attempt.record.bodyKind = "null";
    return body;
  }
  if (typeof body.getReader === "function") {
    attempt.record.bodyKind = "reader";
    return new Proxy(body, {
      get(target, property, receiver) {
        if (property === "getReader") {
          return (...args) => wrapReader(target.getReader(...args), attempt);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    attempt.record.bodyKind = "async_iterable";
    return new Proxy(body, {
      get(target, property, receiver) {
        if (property === Symbol.asyncIterator) {
          return (...args) =>
            wrapAsyncIterator(target[Symbol.asyncIterator](...args), attempt);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
  attempt.record.bodyKind = "other";
  return body;
}

function wrapResponse(response, attempt) {
  const bodyCache = { initialized: false, value: undefined };
  const headersCache = { initialized: false, value: undefined };
  return new Proxy(response, {
    get(target, property, receiver) {
      if (property === "status") {
        try {
          const status = Reflect.get(target, property, target);
          attempt.record.status = Number.isInteger(status) ? status : "invalid";
          return status;
        } catch (error) {
          attempt.record.status = "unreadable";
          throw error;
        }
      }
      if (property === "headers") {
        if (!headersCache.initialized) {
          headersCache.initialized = true;
          headersCache.value = wrapHeaders(
            Reflect.get(target, property, target),
            attempt
          );
        }
        return headersCache.value;
      }
      if (property === "body") {
        if (!bodyCache.initialized) {
          bodyCache.initialized = true;
          bodyCache.value = wrapBody(
            Reflect.get(target, property, target),
            attempt
          );
        }
        return bodyCache.value;
      }
      if (property === "arrayBuffer" && typeof target.arrayBuffer === "function") {
        return async (...args) => {
          try {
            const value = await target.arrayBuffer(...args);
            attempt.record.bodyKind = "array_buffer";
            observeChunk(attempt, new Uint8Array(value));
            finishAttempt(attempt, "complete");
            return value;
          } catch (error) {
            finishAttempt(attempt, "rejected");
            throw error;
          }
        };
      }
      if (property === "text" && typeof target.text === "function") {
        return async (...args) => {
          try {
            const value = await target.text(...args);
            attempt.record.bodyKind = "text";
            attempt.record.byteCountMode = "unavailable";
            attempt.record.diagnosticOutcome = "decoded_text_unobserved";
            finishAttempt(attempt, "complete");
            return value;
          } catch (error) {
            finishAttempt(attempt, "rejected");
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function snapshotReport(attempts, callCount, attemptsOverLimit) {
  return {
    schemaVersion: 1,
    callCountCapped: Math.min(callCount, STRUCTURAL_DIAGNOSTIC_LIMITS.counters),
    callCountOverLimit: callCount >= STRUCTURAL_DIAGNOSTIC_LIMITS.counters,
    attemptsOverLimit,
    attempts: attempts.map(({ record }) => structuredClone(record))
  };
}

/**
 * Wrap a test-host fetch implementation with bounded structural telemetry.
 *
 * The wrapper deliberately does not inspect its URL or init arguments. It
 * records only allowlisted response structure and returns the original
 * response values/chunks/errors to the caller.
 */
export function createStructuralDiagnosticFetch(innerFetch) {
  if (typeof innerFetch !== "function") {
    throw new TypeError("innerFetch must be a function");
  }

  const attempts = [];
  let callCount = 0;
  let attemptsOverLimit = false;

  async function fetchWithDiagnostics(...args) {
    callCount += 1;
    const attempt = createAttemptRecord();
    if (attempts.length < STRUCTURAL_DIAGNOSTIC_LIMITS.attempts) {
      attempts.push(attempt);
    } else {
      attemptsOverLimit = true;
    }

    try {
      // Do not read, clone, normalize, log, or retain any request argument.
      const response = await innerFetch(...args);
      attempt.record.fetchOutcome = "response";
      return wrapResponse(response, attempt);
    } catch (error) {
      attempt.record.fetchOutcome = "rejected";
      throw error;
    }
  }

  return {
    fetch: fetchWithDiagnostics,
    finish() {
      for (const attempt of attempts) {
        if (attempt.record.bodyOutcome !== "unread") {
          finishAttempt(attempt, attempt.record.bodyOutcome);
        }
      }
      return snapshotReport(attempts, callCount, attemptsOverLimit);
    }
  };
}
