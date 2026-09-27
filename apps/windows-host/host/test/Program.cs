using System.Text.Json;
using PersonalAgent.WindowsHost.Service;

if (args.Length != 2) throw new ArgumentException("Pass #168 schema and fixture paths");
var wire = new HostWire(args[0]);
using var fixtures = JsonDocument.Parse(File.ReadAllText(args[1]));
foreach (var valid in fixtures.RootElement.GetProperty("valid").EnumerateArray())
{
    using var parsed = wire.Parse(JsonSerializer.SerializeToUtf8Bytes(valid));
    if (parsed.RootElement.GetProperty("kind").GetString() != valid.GetProperty("kind").GetString())
        throw new Exception("Fixture frame kind changed");
}
foreach (var invalid in fixtures.RootElement.GetProperty("invalid").EnumerateArray())
{
    try
    {
        using var parsed = wire.Parse(JsonSerializer.SerializeToUtf8Bytes(invalid));
        throw new Exception("Host accepted an invalid contracts fixture");
    }
    catch (InvalidDataException) { }
}

var targetReadyValid = new
{
    kind = "target_ready",
    protocolVersion = "0.1.0",
    requestId = "req-tr-1",
    sessionId = "s1",
    targetRef = "opaque-notepad-1",
    deadline = "2026-09-27T12:00:00.000Z"
};
using var parsedTr = wire.Parse(wire.Encode(targetReadyValid)[..^1]);
if (parsedTr.RootElement.GetProperty("kind").GetString() != "target_ready")
    throw new Exception("target_ready frame parse failed");

var targetReadyResultTrue = new
{
    kind = "target_ready_result",
    protocolVersion = "0.1.0",
    requestId = "req-tr-1",
    sessionId = "s1",
    targetRef = "opaque-notepad-1",
    ready = true,
    expiresAt = "2026-09-27T12:00:30.000Z"
};
using var parsedTrrTrue = wire.Parse(wire.Encode(targetReadyResultTrue)[..^1]);
if (parsedTrrTrue.RootElement.GetProperty("ready").GetBoolean() != true)
    throw new Exception("target_ready_result true parse failed");

var targetReadyResultFalse = new
{
    kind = "target_ready_result",
    protocolVersion = "0.1.0",
    requestId = "req-tr-1",
    sessionId = "s1",
    targetRef = "opaque-notepad-1",
    ready = false,
    errorCode = "TARGET_STALE"
};
using var parsedTrrFalse = wire.Parse(wire.Encode(targetReadyResultFalse)[..^1]);
if (parsedTrrFalse.RootElement.GetProperty("ready").GetBoolean() != false)
    throw new Exception("target_ready_result false parse failed");

try
{
    var invalidTrrBoth = new
    {
        kind = "target_ready_result",
        protocolVersion = "0.1.0",
        requestId = "req-tr-1",
        sessionId = "s1",
        targetRef = "opaque-notepad-1",
        ready = true,
        expiresAt = "2026-09-27T12:00:30.000Z",
        errorCode = "TARGET_STALE"
    };
    wire.Parse(JsonSerializer.SerializeToUtf8Bytes(invalidTrrBoth));
    throw new Exception("Host accepted target_ready_result with both expiresAt and errorCode");
}
catch (InvalidDataException) { }

try
{
    var invalidTrrExpiresWhenFalse = new
    {
        kind = "target_ready_result",
        protocolVersion = "0.1.0",
        requestId = "req-tr-1",
        sessionId = "s1",
        targetRef = "opaque-notepad-1",
        ready = false,
        expiresAt = "2026-09-27T12:00:30.000Z",
        errorCode = "TARGET_STALE"
    };
    wire.Parse(JsonSerializer.SerializeToUtf8Bytes(invalidTrrExpiresWhenFalse));
    throw new Exception("Host accepted target_ready_result with ready=false and expiresAt");
}
catch (InvalidDataException) { }

try
{
    var invalidTrrStringReady = new
    {
        kind = "target_ready_result",
        protocolVersion = "0.1.0",
        requestId = "req-tr-1",
        sessionId = "s1",
        targetRef = "opaque-notepad-1",
        ready = "true",
        expiresAt = "2026-09-27T12:00:30.000Z"
    };
    wire.Parse(JsonSerializer.SerializeToUtf8Bytes(invalidTrrStringReady));
    throw new Exception("Host accepted target_ready_result with string ready");
}
catch (InvalidDataException) { }

var journalPath = Path.Combine(Path.GetTempPath(), $"pa-host-fixture-{Guid.NewGuid():N}.jsonl");
try
{
    var identity = new HostRunIdentity("task", "run", "computer.notepad.replace_text", "1.0.0",
        "grant", new string('a', 64), "opaque-notepad-1", RunJournal.PayloadDigest("before", "after"));
    var journal = new RunJournal(journalPath);
    if (journal.Start(identity, "2026-09-25T12:00:00.000Z") is not null)
        throw new Exception("New run was treated as replay");
    var restored = new RunJournal(journalPath);
    if (restored.Find("run")?.Terminal != false ||
        restored.Start(identity, "2026-09-25T12:00:00.000Z") is null)
        throw new Exception("Interrupted run did not remain uncertain");
    try
    {
        restored.Start(identity with {PayloadDigest = RunJournal.PayloadDigest("changed", "after")},
            "2026-09-25T12:00:00.000Z");
        throw new Exception("Changed input reused a runId");
    }
    catch (InvalidDataException) { }
    restored.Complete(identity, "result_unknown", "2026-09-25T12:01:00.000Z", null, "RESULT_UNKNOWN");
    if (new RunJournal(journalPath).Find("run")?.State != "result_unknown")
        throw new Exception("Durable result was not recovered");
}
finally { if (File.Exists(journalPath)) File.Delete(journalPath); }
Console.WriteLine("Windows Host portable contract and durable-run fixture passed");
