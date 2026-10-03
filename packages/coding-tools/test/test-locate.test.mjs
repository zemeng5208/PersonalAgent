import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {locateTestFailures} from '../dist/test-locate/locate.js';

async function repo() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pa-test-locate-'));
  await writeFile(path.join(directory, 'src', 'calc.js').replace(/[/\\]src[/\\]calc\.js$/, ''), '', {flag: 'wx'}).catch(() => {});
  const {mkdir} = await import('node:fs/promises');
  await mkdir(path.join(directory, 'src'), {recursive: true});
  await writeFile(path.join(directory, 'src', 'calc.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  return directory;
}

test('spec output maps failure frames to repo files with snippets and confidence', async () => {
  const root = await repo();
  try {
    const output = [
      '▶ suite',
      '✖ adds numbers (12.3ms)',
      '  AssertionError [ERR_ASSERTION]: expected 1 to be 2',
      '      at TestContext.<anonymous> (src/calc.test.mjs:7:5)',
      '      at add (src/calc.js:2:10)',
      '      at node:internal/test_runner/runner:99:1',
      'ℹ tests 1',
      'ℹ pass 0',
      'ℹ fail 1',
      '✖ failing tests:',
      '',
      'test at src\\calc.test.mjs:7:1',
      '✖ adds numbers (12.3ms)',
      '  AssertionError: expected 1 to be 2',
      '',
    ].join('\n');
    const report = locateTestFailures(output, {root});
    assert.equal(report.totalFailures, 1);
    const failure = report.failures[0];
    assert.equal(failure.name, 'adds numbers');
    assert.equal(failure.reporter, 'spec');
    assert.match(failure.error, /expected 1 to be 2/);
    assert.equal(failure.timedOut, false);
    assert.equal(failure.frames.length, 2);
    assert.deepEqual(failure.frames.map(f => f.file), ['src/calc.test.mjs', 'src/calc.js']);
    assert.equal(failure.frames[0].line, 7);
    assert.equal(failure.frames[0].column, 5);
    assert.ok(failure.frames[0].confidence >= failure.frames[1].confidence);
    // Internal frames are dropped; snippets appear only for readable repo files.
    assert.equal(failure.frames.some(f => f.file.includes('node:internal')), false);
    assert.equal(failure.frames.some(f => f.file.includes('node_modules')), false);
    assert.equal(failure.frames[0].snippet, undefined); // fixture repo has no calc.test.mjs
    assert.match(failure.frames[1].snippet ?? '', /^> 2 .*return a - b;/m);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('TAP output parses failures, dedupes frames and flags timeouts', () => {
  const output = [
    'TAP version 13',
    'ok 1 - passes',
    'not ok 2 - slow thing # Timeout',
    '    ---',
    '    error: Test timed out after 5000ms',
    '      at async run (file:///repo/src/slow.mjs:42)',
    '      at async run (file:///repo/src/slow.mjs:42)',
    '    ...',
  ].join('\n');
  const report = locateTestFailures(output, {root: process.cwd()});
  assert.equal(report.totalFailures, 1);
  const failure = report.failures[0];
  assert.equal(failure.reporter, 'tap');
  assert.equal(failure.name, 'slow thing');
  assert.equal(failure.timedOut, true);
  assert.equal(failure.frames.length, 1);
  assert.equal(failure.frames[0].line, 42);
  assert.equal(failure.frames[0].column, undefined);
  assert.ok(failure.frames[0].confidence < 1); // timeouts and test files are discounted
});

test('frames without columns and outside-repo files are handled', () => {
  const output = [
    '✖ weird case (3ms)',
    '  Error: boom',
    '      at fn (/elsewhere/x.js:9)',
    '      at fn2 (src/a.ts:4)',
  ].join('\n');
  const report = locateTestFailures(output, {root: process.cwd()});
  const failure = report.failures[0];
  assert.equal(failure.frames.length, 2);
  assert.equal(failure.frames[1].column, undefined);
  // Outside-root paths are preserved verbatim rather than dropped.
  assert.equal(failure.frames[0].file, '/elsewhere/x.js');
  assert.equal(failure.frames[1].file, 'src/a.ts');
});

test('no failures yields an empty report instead of an error', () => {
  const report = locateTestFailures('ℹ tests 4\nℹ pass 4\nℹ fail 0\n');
  assert.deepEqual(report.failures, []);
  assert.equal(report.totalFailures, 0);
});

test('duplicate summary and detail blocks collapse to one failure', () => {
  const output = [
    '✖ dup (1ms)',
    '✖ failing tests:',
    '✖ dup (1ms)',
    '  Error: same',
  ].join('\n');
  const report = locateTestFailures(output);
  assert.equal(report.totalFailures, 1);
  assert.equal(report.failures[0].name, 'dup');
});

test('oversized input and invalid options are rejected', async () => {
  assert.throws(() => locateTestFailures('x'.repeat(64), {maxInputBytes: 8}), /byte limit/u);
  assert.throws(() => locateTestFailures('ok', {contextLines: 99}), /context/u);
  assert.throws(() => locateTestFailures(42), /string/u);
});
