import test from "node:test";
import assert from "node:assert/strict";

import {
  createStructuralDiagnosticFetch,
  STRUCTURAL_DIAGNOSTIC_LIMITS
} from "./structural-fetch.mjs";

const encoder = new TextEncoder();

test("iterator throw records rejection without changing the original error", async () => {
  const error = new Error("THROW_CANARY");
  const diagnostic = createStructuralDiagnosticFetch(async () => ({
    status: 200,
    body: {
      [Symbol.asyncIterator]() {
        return {
          async next() { return {done: true}; },
          async throw() { throw error; }
        };
      }
    }
  }));
  const response = await diagnostic.fetch();
  const iterator = response.body[Symbol.asyncIterator]();
  await assert.rejects(iterator.throw(error), thrown => thrown === error);
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].bodyOutcome, "rejected");
  assert.equal(JSON.stringify(report).includes("THROW_CANARY"), false);
});

test("JSON responses explicitly report that their events were not parsed", async () => {
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    new Response('[{"event":"task_end","data":{}}]', {
      headers: {"content-type": "application/json"}
    })
  );
  const response = await diagnostic.fetch();
  await consumeReader(response);
  response.headers.get("content-type");
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].eventInspection, "json_unparsed");
  assert.deepEqual(report.attempts[0].events, []);
});

function createReader(chunks, failure) {
  let index = 0;
  return {
    async read() {
      if (failure && index === failure.at) {
        index += 1;
        throw failure.error;
      }
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    releaseLock() {}
  };
}

function createResponse({
  chunks = [],
  contentType = "text/event-stream; charset=utf-8",
  status = 200,
  failure
} = {}) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      }
    },
    body: {
      getReader() {
        return createReader(chunks, failure);
      }
    }
  };
}

async function consumeReader(response) {
  const reader = response.body.getReader();
  const chunks = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return chunks;
    }
    chunks.push(result.value);
  }
}

test("passes one request and original chunks while emitting only allowlisted structure", async () => {
  const secretUrl = "https://secret.invalid/path?token=URL_CANARY";
  const init = {
    headers: { authorization: "Bearer HEADER_CANARY" },
    body: "REQUEST_BODY_CANARY"
  };
  const first = encoder.encode(
    'data: {"event":"workflow_start","data":{"workflow_name":"PRIVATE_WORKFLOW"}}\n\n'
  );
  const second = encoder.encode(
    'data: {"event":"message","data":{"text":"PRIVATE_ANSWER"}}\n'
  );
  const third = encoder.encode(
    'data: {"event":"task_end","data":{"status":"success"}}\n\n'
  );
  let calls = 0;
  const innerFetch = async (url, passedInit) => {
    calls += 1;
    assert.equal(url, secretUrl);
    assert.equal(passedInit, init);
    return createResponse({ chunks: [first, second, third] });
  };
  const diagnostic = createStructuralDiagnosticFetch(innerFetch);

  const response = await diagnostic.fetch(secretUrl, init);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const output = await consumeReader(response);

  assert.equal(calls, 1);
  assert.deepEqual(output, [first, second, third]);
  assert.equal(output[0], first);
  assert.equal(output[1], second);
  assert.equal(output[2], third);

  const report = diagnostic.finish();
  assert.deepEqual(
    report.attempts[0].events.map((event) => event.name),
    ["workflow_start", "message", "task_end"]
  );
  assert.equal(report.attempts[0].contentType, "text/event-stream");
  assert.equal(report.attempts[0].bodyOutcome, "complete");
  assert.equal(report.attempts[0].events[1].data.text.type, "string");
  assert.equal(report.attempts[0].events[1].data.text.lengthCapped, 14);

  const serialized = JSON.stringify(report);
  for (const canary of [
    "URL_CANARY",
    "HEADER_CANARY",
    "REQUEST_BODY_CANARY",
    "PRIVATE_WORKFLOW",
    "PRIVATE_ANSWER"
  ]) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("maps malicious event names and fields to bounded shapes", async () => {
  const maliciousName = "EVENT_NAME_CANARY";
  const maliciousStatus = "STATUS_CANARY";
  const maliciousMessage = "MESSAGE_CANARY";
  const payload = `{"event":"${maliciousName}","status":"${maliciousStatus}","topSecretKey":"TOP_SECRET_CANARY","__proto__":{"polluted":"PROTO_CANARY"},"constructor":"CONSTRUCTOR_CANARY","data":{"message":"${maliciousMessage}","unknownSecretKey":"DATA_SECRET_CANARY","__proto__":"DATA_PROTO_CANARY","constructor":"DATA_CONSTRUCTOR_CANARY"}}`;
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    Object.assign(
      createResponse({ chunks: [encoder.encode(`data: ${payload}\n\n`)] }),
      { statusText: "STATUS_TEXT_CANARY" }
    )
  );
  const response = await diagnostic.fetch("ignored", { secret: "INIT_CANARY" });
  assert.equal(response.statusText, "STATUS_TEXT_CANARY");
  response.headers.get("content-type");
  await consumeReader(response);

  const report = diagnostic.finish();
  const event = report.attempts[0].events[0];
  assert.equal(event.name, "other");
  assert.equal(event.top.status.type, "string");
  assert.equal(event.data.message.type, "string");
  assert.equal(event.topUnknownKeyCountCapped, 3);
  assert.equal(event.dataUnknownKeyCountCapped, 3);
  assert.equal(Object.prototype.polluted, undefined);
  const serialized = JSON.stringify(report);
  for (const canary of [
    maliciousName,
    maliciousStatus,
    maliciousMessage,
    "TOP_SECRET_CANARY",
    "DATA_SECRET_CANARY",
    "PROTO_CANARY",
    "CONSTRUCTOR_CANARY",
    "DATA_PROTO_CANARY",
    "DATA_CONSTRUCTOR_CANARY",
    "STATUS_TEXT_CANARY",
    "INIT_CANARY"
  ]) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("rethrows the original fetch failure without error details", async () => {
  const failure = new Error("FETCH_ERROR_CANARY");
  failure.name = "FETCH_NAME_CANARY";
  const diagnostic = createStructuralDiagnosticFetch(async () => {
    throw failure;
  });

  await assert.rejects(
    diagnostic.fetch("URL_CANARY", { headers: { secret: "HEADER_CANARY" } }),
    (error) => error === failure
  );
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].fetchOutcome, "rejected");
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("FETCH_ERROR_CANARY"), false);
  assert.equal(serialized.includes("FETCH_NAME_CANARY"), false);
  assert.equal(serialized.includes("URL_CANARY"), false);
  assert.equal(serialized.includes("HEADER_CANARY"), false);
});

test("rethrows the original stream failure without swallowing earlier chunks", async () => {
  const first = encoder.encode('data: {"event":"task_start"}\n\n');
  const failure = new Error("STREAM_ERROR_CANARY");
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks: [first], failure: { at: 1, error: failure } })
  );
  const response = await diagnostic.fetch("ignored", {});
  const reader = response.body.getReader();

  const firstResult = await reader.read();
  assert.equal(firstResult.value, first);
  await assert.rejects(reader.read(), (error) => error === failure);
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].bodyOutcome, "rejected");
  assert.equal(JSON.stringify(report).includes("STREAM_ERROR_CANARY"), false);
});

test("passes AbortSignal by identity without attaching request observers", async () => {
  const controller = new AbortController();
  const init = { signal: controller.signal };
  let passedInit;
  const diagnostic = createStructuralDiagnosticFetch(async (_url, value) => {
    passedInit = value;
    return createResponse();
  });

  const response = await diagnostic.fetch("ignored", init);
  await consumeReader(response);
  assert.equal(passedInit, init);
  assert.equal(passedInit.signal, controller.signal);
});

test("bounds events, inspected bytes, counters, and serialized report size", async () => {
  const events = [];
  for (let index = 0; index < STRUCTURAL_DIAGNOSTIC_LIMITS.events + 100; index += 1) {
    events.push(
      `data: {"event":"message","data":{"text":"LARGE_BODY_CANARY_${index}_${"x".repeat(1000)}"}}\n`
    );
  }
  const large = encoder.encode(events.join(""));
  const chunks = [];
  for (let offset = 0; offset < large.byteLength; offset += 4096) {
    chunks.push(large.subarray(offset, Math.min(offset + 4096, large.byteLength)));
  }
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks })
  );
  const response = await diagnostic.fetch("ignored", {});
  const output = await consumeReader(response);
  assert.equal(output.length, chunks.length);
  for (let index = 0; index < chunks.length; index += 1) {
    assert.equal(output[index], chunks[index]);
  }

  const report = diagnostic.finish();
  const attempt = report.attempts[0];
  assert.equal(attempt.events.length <= STRUCTURAL_DIAGNOSTIC_LIMITS.events, true);
  assert.equal(attempt.inspectedByteCount <= STRUCTURAL_DIAGNOSTIC_LIMITS.inspectedBytes, true);
  assert.equal(attempt.inspectionTruncated, true);
  assert.equal(JSON.stringify(report).includes("LARGE_BODY_CANARY"), false);
  assert.equal(JSON.stringify(report).length < 100_000, true);
});

test("marks invalid UTF-8 and preserves its bytes", async () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks: [bytes] })
  );
  const response = await diagnostic.fetch("ignored", {});
  const output = await consumeReader(response);
  assert.equal(output[0], bytes);
  assert.equal(diagnostic.finish().attempts[0].utf8, "invalid");
});

test("normalizes missing and foreign content types without retaining values", async () => {
  for (const [contentType, expected, canary] of [
    [null, "missing", null],
    ["application/CONTENT_TYPE_CANARY", "other", "CONTENT_TYPE_CANARY"]
  ]) {
    const diagnostic = createStructuralDiagnosticFetch(async () =>
      createResponse({ contentType })
    );
    const response = await diagnostic.fetch("ignored", {});
    assert.equal(response.headers.get("content-type"), contentType);
    await consumeReader(response);
    const report = diagnostic.finish();
    assert.equal(report.attempts[0].contentType, expected);
    if (canary) {
      assert.equal(JSON.stringify(report).includes(canary), false);
    }
  }
});

test("keeps diagnostic parsing failures from changing response consumption", async () => {
  const malformed = encoder.encode(
    `data: {"event":"message","data":{"text":"${"x".repeat(
      STRUCTURAL_DIAGNOSTIC_LIMITS.eventPayloadCharacters + 100
    )}"}}\n\n`
  );
  const after = encoder.encode('data: {"event":"task_end"}\n\n');
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks: [malformed, after] })
  );
  const response = await diagnostic.fetch("ignored", {});
  const output = await consumeReader(response);
  assert.equal(output[0], malformed);
  assert.equal(output[1], after);
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].inspectionTruncated, true);
});

test("preserves async iterator return behavior and chunk identity", async () => {
  const chunk = encoder.encode('data: {"event":"task_start"}\n\n');
  const returned = { done: true, value: "RETURN_VALUE_CANARY" };
  let nextCalls = 0;
  let returnCalls = 0;
  const body = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          nextCalls += 1;
          return { done: false, value: chunk };
        },
        async return() {
          returnCalls += 1;
          return returned;
        }
      };
    }
  };
  const diagnostic = createStructuralDiagnosticFetch(async () => ({
    status: 200,
    headers: { get: () => "text/event-stream" },
    body
  }));
  const response = await diagnostic.fetch("ignored", {});
  const iterator = response.body[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value, chunk);
  const returnResult = await iterator.return("RELEASE_REASON_CANARY");
  assert.equal(returnResult, returned);
  assert.equal(nextCalls, 1);
  assert.equal(returnCalls, 1);
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].bodyOutcome, "released");
  assert.equal(JSON.stringify(report).includes("RETURN_VALUE_CANARY"), false);
  assert.equal(JSON.stringify(report).includes("RELEASE_REASON_CANARY"), false);
});

test("does not add iterator release methods that the source lacks", async () => {
  const iterator = {
    async next() {
      return { done: true, value: undefined };
    }
  };
  const diagnostic = createStructuralDiagnosticFetch(async () => ({
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: {
      [Symbol.asyncIterator]() {
        return iterator;
      }
    }
  }));
  const response = await diagnostic.fetch("ignored", {});
  const wrapped = response.body[Symbol.asyncIterator]();
  assert.equal(Object.hasOwn(wrapped, "return"), false);
  assert.equal(Object.hasOwn(wrapped, "throw"), false);
  assert.deepEqual(await wrapped.next(), { done: true, value: undefined });
});

test("supports native Response, Headers, ReadableStream, and reader getters", async () => {
  const first = encoder.encode('data: {"event":"workflow_start"}\n\n');
  const second = encoder.encode('data: {"event":"task_end"}\n\n');
  const source = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      }
    }),
    {
      status: 201,
      statusText: "NATIVE_STATUS_TEXT_CANARY",
      headers: new Headers({
        "content-type": "text/event-stream; charset=utf-8"
      })
    }
  );
  const diagnostic = createStructuralDiagnosticFetch(async () => source);
  const response = await diagnostic.fetch("ignored", {});

  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.statusText, "NATIVE_STATUS_TEXT_CANARY");
  assert.equal(response.headers instanceof Headers, true);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.body.locked, false);
  const reader = response.body.getReader();
  assert.equal(response.body.locked, true);
  assert.equal(reader.closed instanceof Promise, true);
  const chunks = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
  }
  assert.equal(chunks[0], first);
  assert.equal(chunks[1], second);
  reader.releaseLock();

  const report = diagnostic.finish();
  assert.equal(report.attempts[0].status, 201);
  assert.equal(report.attempts[0].contentType, "text/event-stream");
  assert.deepEqual(
    report.attempts[0].events.map((event) => event.name),
    ["workflow_start", "task_end"]
  );
  assert.equal(JSON.stringify(report).includes("NATIVE_STATUS_TEXT_CANARY"), false);
});

test("observes the valid prefix of the chunk that crosses the inspection cap", async () => {
  const prefixLength = STRUCTURAL_DIAGNOSTIC_LIMITS.inspectedBytes - 80;
  const filler = encoder.encode(":x\n".repeat(Math.floor(prefixLength / 3)));
  const terminal = encoder.encode('data: {"event":"task_end"}\n\n');
  const trailing = encoder.encode("TRAILING_CONTENT_CANARY".repeat(20));
  const crossingChunk = new Uint8Array(terminal.byteLength + trailing.byteLength);
  crossingChunk.set(terminal, 0);
  crossingChunk.set(trailing, terminal.byteLength);
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks: [filler, crossingChunk] })
  );
  const response = await diagnostic.fetch("ignored", {});
  const output = await consumeReader(response);
  assert.equal(output[0], filler);
  assert.equal(output[1], crossingChunk);

  const report = diagnostic.finish();
  assert.equal(report.attempts[0].inspectionTruncated, true);
  assert.equal(
    report.attempts[0].events.some((event) => event.name === "task_end"),
    true
  );
  assert.equal(JSON.stringify(report).includes("TRAILING_CONTENT_CANARY"), false);
});

test("flushes a final decoder code point and unterminated data line", async () => {
  const bytes = encoder.encode('data: {"event":"task_end","data":{"text":"尾"}}');
  const split = bytes.byteLength - 1;
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks: [bytes.subarray(0, split), bytes.subarray(split)] })
  );
  const response = await diagnostic.fetch("ignored", {});
  await consumeReader(response);
  const report = diagnostic.finish();
  assert.deepEqual(
    report.attempts[0].events.map((event) => event.name),
    ["task_end"]
  );
});

test("does not call an inspection-cap split UTF-8 code point invalid", async () => {
  const filler = encoder.encode(
    ":\n".repeat((STRUCTURAL_DIAGNOSTIC_LIMITS.inspectedBytes - 2) / 2)
  );
  const crossingChunk = encoder.encode("尾");
  const diagnostic = createStructuralDiagnosticFetch(async () =>
    createResponse({ chunks: [filler, crossingChunk] })
  );
  const response = await diagnostic.fetch("ignored", {});
  const output = await consumeReader(response);
  assert.equal(output[0], filler);
  assert.equal(output[1], crossingChunk);

  const report = diagnostic.finish();
  assert.equal(report.attempts[0].inspectionTruncated, true);
  assert.equal(report.attempts[0].utf8, "unknown");
  assert.equal(report.attempts[0].bodyOutcome, "complete");
  assert.equal(
    report.attempts[0].byteCountCapped,
    filler.byteLength + crossingChunk.byteLength
  );
});

test("marks the decoded-text fallback byte count unavailable without retaining text", async () => {
  const text = "DECODED_TEXT_CANARY";
  const diagnostic = createStructuralDiagnosticFetch(async () => ({
    status: 200,
    headers: { get: () => "text/event-stream" },
    text: async () => text
  }));
  const response = await diagnostic.fetch("ignored", {});
  assert.equal(await response.text(), text);
  const report = diagnostic.finish();
  assert.equal(report.attempts[0].bodyKind, "text");
  assert.equal(report.attempts[0].byteCountMode, "unavailable");
  assert.equal(report.attempts[0].byteCountCapped, 0);
  assert.equal(report.attempts[0].inspectedByteCount, 0);
  assert.equal(report.attempts[0].diagnosticOutcome, "decoded_text_unobserved");
  assert.equal(JSON.stringify(report).includes(text), false);
});
