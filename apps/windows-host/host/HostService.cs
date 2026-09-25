using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json;

namespace PersonalAgent.WindowsHost.Service;

internal sealed class HostService(HostLaunchBinding launch, HostWire wire, RunJournal journal)
{
    private const string Version = "0.1.0";
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _active = new(StringComparer.Ordinal);

    internal async Task RunAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            using var pipe = new NamedPipeServerStream(launch.PipeName, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.WaitForConnectionAsync(stop).ConfigureAwait(false);
            launch.Verify(pipe);
            var targets = new NotepadTargets();
            using var connection = CancellationTokenSource.CreateLinkedTokenSource(stop);
            try { await ServeConnectionAsync(pipe, targets, connection.Token).ConfigureAwait(false); }
            finally
            {
                connection.Cancel();
                targets.Clear(); // Target refs are never executable after disconnect.
                foreach (var active in _active.Values)
                {
                    try { active.Cancel(); }
                    catch (ObjectDisposedException) { /* Completion won the disconnect race. */ }
                }
            }
        }
    }

    private async Task ServeConnectionAsync(NamedPipeServerStream pipe, NotepadTargets targets,
        CancellationToken connected)
    {
        var reader = new BoundedJsonlReader(pipe);
        using var hello = await ReadRequiredAsync(reader, connected).ConfigureAwait(false);
        if (Kind(hello.RootElement) != "hello") throw new InvalidDataException("Expected Windows Host hello");
        var first = hello.RootElement;
        var helloRequest = Field(first, "requestId");
        var clientNonce = Field(first, "clientNonce");
        var hostNonce = RandomId();
        var sessionId = RandomId();
        await SendAsync(pipe, new
        {
            kind = "hello_ack", protocolVersion = Version, requestId = helloRequest,
            clientNonce, hostNonce, sessionId
        }, connected).ConfigureAwait(false);
        using var bind = await ReadRequiredAsync(reader, connected).ConfigureAwait(false);
        var bound = bind.RootElement;
        if (Kind(bound) != "bind" || Field(bound, "requestId") != helloRequest ||
            Field(bound, "sessionId") != sessionId || Field(bound, "hostNonce") != hostNonce)
            throw new InvalidDataException("Windows Host handshake did not bind");

        while (!connected.IsCancellationRequested)
        {
            var bytes = await reader.ReadAsync(connected).ConfigureAwait(false);
            if (bytes is null) return;
            using var message = wire.Parse(bytes);
            var frame = message.RootElement;
            if (Field(frame, "sessionId") != sessionId)
                throw new InvalidDataException("Windows Host session changed");
            switch (Kind(frame))
            {
                case "observe":
                    await ObserveAsync(pipe, targets, frame, connected).ConfigureAwait(false);
                    break;
                case "execute":
                    await StartExecuteAsync(pipe, targets, frame, connected).ConfigureAwait(false);
                    break;
                case "cancel":
                    Cancel(frame);
                    break;
                case "status":
                    await StatusAsync(pipe, frame, connected).ConfigureAwait(false);
                    break;
                default:
                    throw new InvalidDataException("Unexpected Windows Host client frame");
            }
        }
    }

    private async Task ObserveAsync(NamedPipeServerStream pipe, NotepadTargets targets,
        JsonElement frame, CancellationToken connected)
    {
        var requestId = Field(frame, "requestId");
        var sessionId = Field(frame, "sessionId");
        var deadline = Utc(Field(frame, "deadline"));
        (ObservedNotepadTarget? target, string? error) result;
        try { result = targets.Observe(deadline); }
        catch { result = (null, "EXTERNAL_FAILURE"); }
        if (result.target is null)
        {
            await SendAsync(pipe, new
            {
                kind = "observation_refused", protocolVersion = Version, requestId, sessionId,
                errorCode = result.error ?? "EXTERNAL_FAILURE"
            }, connected).ConfigureAwait(false);
            return;
        }
        await SendAsync(pipe, new
        {
            kind = "observed", protocolVersion = Version, requestId, sessionId,
            targetRef = result.target.Reference, expiresAt = Timestamp(result.target.ExpiresUtc),
            source = "windows-uia"
        }, connected).ConfigureAwait(false);
    }

    private async Task StartExecuteAsync(NamedPipeServerStream pipe, NotepadTargets targets,
        JsonElement frame, CancellationToken connected)
    {
        var requestId = Field(frame, "requestId");
        var sessionId = Field(frame, "sessionId");
        var identity = new HostRunIdentity(
            Field(frame, "taskId"), Field(frame, "runId"), Field(frame, "toolName"),
            Field(frame, "toolVersion"), Field(frame, "authorizationRef"),
            Field(frame, "argumentsDigest"), Field(frame, "targetRef"),
            RunJournal.PayloadDigest(Field(frame, "expectedText"), Field(frame, "replacementText")));
        var startedAt = Timestamp(DateTime.UtcNow);
        // A reference in the frame is not a grant. The exact OS-bound client must
        // have consumed Policy authorization through Runtime/ToolGateway first.
        var previous = journal.Start(identity, startedAt);
        if (previous is not null)
        {
            await SendRecordAsync(pipe, previous, requestId, sessionId, connected).ConfigureAwait(false);
            return; // Reconnects and duplicate runIds never replay a write.
        }

        var deadline = Utc(Field(frame, "deadline"));
        ObservedNotepadTarget? target;
        try { target = targets.Resolve(identity.TargetRef); }
        catch { target = null; } // A vanished UIA target is a write-before refusal.
        if (deadline <= DateTime.UtcNow || target is null ||
            Field(frame, "expectedText") == Field(frame, "replacementText"))
        {
            var refused = journal.Complete(identity, "refused", Timestamp(DateTime.UtcNow), null,
                deadline <= DateTime.UtcNow ? "TIMEOUT" : target is null ? "TARGET_STALE" : "INVALID_ARGUMENT");
            await SendRecordAsync(pipe, refused, requestId, sessionId, connected).ConfigureAwait(false);
            return;
        }

        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(connected);
        var watchdogUtc = DateTime.UtcNow.AddMinutes(10);
        var effectiveDeadline = deadline < watchdogUtc ? deadline : watchdogUtc;
        var remaining = effectiveDeadline - DateTime.UtcNow;
        if (remaining <= TimeSpan.Zero)
        {
            lifetime.Dispose();
            var refused = journal.Complete(identity, "refused", Timestamp(DateTime.UtcNow), null, "TIMEOUT");
            await SendRecordAsync(pipe, refused, requestId, sessionId, connected).ConfigureAwait(false);
            return;
        }
        lifetime.CancelAfter(remaining);
        if (!_active.TryAdd(identity.RunId, lifetime))
        {
            lifetime.Dispose();
            await SendRecordAsync(pipe, journal.Find(identity.RunId)!, requestId, sessionId, connected)
                .ConfigureAwait(false);
            return;
        }
        var expectedText = Field(frame, "expectedText");
        var replacementText = Field(frame, "replacementText");
        _ = Task.Run(async () =>
        {
            try
            {
                var action = await NotepadAction.ReplaceTextAsync(new ConfirmedNotepadTarget(
                    target.Window, target.ProcessId, target.StartUtc, expectedText, replacementText),
                    lifetime.Token).ConfigureAwait(false);
                var state = action.State == ActionState.Verified && !lifetime.IsCancellationRequested
                    ? "verified" : action.State == ActionState.Rejected && lifetime.IsCancellationRequested
                        ? "cancelled" : action.State == ActionState.Rejected ? "refused" : "result_unknown";
                var error = state switch
                {
                    "verified" => null,
                    "cancelled" => effectiveDeadline <= DateTime.UtcNow ? "TIMEOUT" : "CANCELLED",
                    "refused" => "TARGET_STALE",
                    _ => "RESULT_UNKNOWN"
                };
                var receipt = journal.Complete(identity, state, Timestamp(DateTime.UtcNow),
                    state == "verified" ? RandomId() : null, error);
                await TrySendRecordAsync(pipe, receipt, requestId, sessionId, connected).ConfigureAwait(false);
            }
            catch
            {
                try
                {
                    var receipt = journal.Complete(identity, "result_unknown", Timestamp(DateTime.UtcNow),
                        null, "RESULT_UNKNOWN");
                    await TrySendRecordAsync(pipe, receipt, requestId, sessionId, connected).ConfigureAwait(false);
                }
                catch { Environment.Exit(3); } // The durable started record keeps the result unknown.
            }
            finally
            {
                _active.TryRemove(identity.RunId, out _);
                lifetime.Dispose();
            }
        });
    }

    private void Cancel(JsonElement frame)
    {
        var record = FindMatching(frame);
        if (record is not null && _active.TryGetValue(record.Identity.RunId, out var active))
        {
            try { active.Cancel(); }
            catch (ObjectDisposedException) { /* Completion won the cancel race. */ }
        }
        // There is no cancel acknowledgement frame in 0.1.0. Caller polls status.
    }

    private async Task StatusAsync(NamedPipeServerStream pipe, JsonElement frame,
        CancellationToken connected)
    {
        var requestId = Field(frame, "requestId");
        var sessionId = Field(frame, "sessionId");
        var record = FindMatching(frame);
        if (record is null || _active.ContainsKey(record.Identity.RunId))
        {
            await SendAsync(pipe, new
            {
                kind = "status_reply", protocolVersion = Version, requestId, sessionId,
                taskId = Field(frame, "taskId"), runId = Field(frame, "runId"),
                state = record is null ? "not_found" : "in_progress"
            }, connected).ConfigureAwait(false);
            return;
        }
        await SendRecordAsync(pipe, record, requestId, sessionId, connected).ConfigureAwait(false);
    }

    private HostRunRecord? FindMatching(JsonElement frame)
    {
        var record = journal.Find(Field(frame, "runId"));
        if (record is null) return null;
        var identity = record.Identity;
        if (identity.TaskId != Field(frame, "taskId") ||
            identity.ToolName != Field(frame, "toolName") ||
            identity.ToolVersion != Field(frame, "toolVersion") ||
            identity.ArgumentsDigest != Field(frame, "argumentsDigest") ||
            identity.TargetRef != Field(frame, "targetRef"))
            throw new InvalidDataException("Windows Host run identity changed");
        return record;
    }

    private async Task SendRecordAsync(NamedPipeServerStream pipe, HostRunRecord record,
        string requestId, string sessionId, CancellationToken connected)
    {
        var identity = record.Identity;
        var state = record.Terminal ? record.State : "result_unknown";
        var result = new Dictionary<string, object>
        {
            ["kind"] = "result", ["protocolVersion"] = Version, ["requestId"] = requestId,
            ["sessionId"] = sessionId, ["taskId"] = identity.TaskId, ["runId"] = identity.RunId,
            ["toolName"] = identity.ToolName, ["toolVersion"] = identity.ToolVersion,
            ["argumentsDigest"] = identity.ArgumentsDigest, ["targetRef"] = identity.TargetRef,
            ["state"] = state, ["startedAt"] = record.StartedAt,
            ["finishedAt"] = record.FinishedAt ?? Timestamp(DateTime.UtcNow)
        };
        if (state == "verified") result.Add("evidenceRef", record.EvidenceRef!);
        else result.Add("errorCode", record.ErrorCode ?? "RESULT_UNKNOWN");
        await SendAsync(pipe, result, connected).ConfigureAwait(false);
    }

    private async Task TrySendRecordAsync(NamedPipeServerStream pipe, HostRunRecord record,
        string requestId, string sessionId, CancellationToken connected)
    {
        try { await SendRecordAsync(pipe, record, requestId, sessionId, connected).ConfigureAwait(false); }
        catch (IOException) { /* Durable status is available after reconnect. */ }
        catch (OperationCanceledException) { /* The old session cannot receive results. */ }
        catch (ObjectDisposedException) { /* The old pipe is closed. */ }
    }

    private async Task SendAsync(NamedPipeServerStream pipe, object frame, CancellationToken connected)
    {
        await _writeLock.WaitAsync(connected).ConfigureAwait(false);
        try { await wire.WriteAsync(pipe, frame, connected).ConfigureAwait(false); }
        finally { _writeLock.Release(); }
    }

    private async Task<JsonDocument> ReadRequiredAsync(BoundedJsonlReader reader, CancellationToken connected)
    {
        var bytes = await reader.ReadAsync(connected).ConfigureAwait(false)
            ?? throw new InvalidDataException("Incomplete Windows Host handshake");
        return wire.Parse(bytes);
    }

    private static string Field(JsonElement frame, string name) => frame.GetProperty(name).GetString()!;
    private static string Kind(JsonElement frame) => Field(frame, "kind");
    private static string RandomId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
    private static string Timestamp(DateTime utc) => utc.ToUniversalTime().ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    private static DateTime Utc(string value) => DateTime.ParseExact(value,
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
}
