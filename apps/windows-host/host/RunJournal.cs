using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PersonalAgent.WindowsHost.Service;

internal sealed record HostRunIdentity(
    string TaskId, string RunId, string ToolName, string ToolVersion,
    string AuthorizationRef, string ArgumentsDigest, string TargetRef, string PayloadDigest);

internal sealed record HostRunRecord(
    HostRunIdentity Identity, bool Terminal, string State, string StartedAt,
    string? FinishedAt, string? EvidenceRef, string? ErrorCode);

// Append before the UIA call: a crash or disconnected client can never turn an
// attempted write into a fresh request. No text, path, HWND or PID is persisted.
internal sealed class RunJournal
{
    private const long MaxJournalBytes = 64L * 1024 * 1024;
    private readonly object _gate = new();
    private readonly string _path;
    private readonly Dictionary<string, HostRunRecord> _runs = new(StringComparer.Ordinal);

    internal RunJournal(string path)
    {
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!File.Exists(path)) return;
        if (new FileInfo(path).Length > MaxJournalBytes)
            throw new InvalidDataException("Windows Host journal is too large");
        foreach (var line in File.ReadLines(path))
        {
            var record = JsonSerializer.Deserialize<HostRunRecord>(line)
                ?? throw new InvalidDataException("Invalid Windows Host journal entry");
            if (record.Identity is null || string.IsNullOrEmpty(record.Identity.RunId) ||
                (_runs.TryGetValue(record.Identity.RunId, out var previous) &&
                 previous.Identity != record.Identity))
                throw new InvalidDataException("Windows Host journal identity mismatch");
            _runs[record.Identity.RunId] = record;
        }
    }

    internal static string PayloadDigest(string expectedText, string replacementText)
    {
        // Length-prefix avoids concatenation ambiguity. The body is never saved.
        var bytes = Encoding.UTF8.GetBytes($"{expectedText.Length}:{expectedText}{replacementText.Length}:{replacementText}");
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    internal HostRunRecord? Start(HostRunIdentity identity, string startedAt)
    {
        lock (_gate)
        {
            if (_runs.TryGetValue(identity.RunId, out var existing))
            {
                if (existing.Identity != identity)
                    throw new InvalidDataException("A Windows Host runId was reused for different input");
                return existing;
            }
            var record = new HostRunRecord(identity, false, "result_unknown", startedAt,
                null, null, "RESULT_UNKNOWN");
            Append(record);
            _runs.Add(identity.RunId, record);
            return null;
        }
    }

    internal HostRunRecord Complete(HostRunIdentity identity, string state,
        string finishedAt, string? evidenceRef, string? errorCode)
    {
        lock (_gate)
        {
            if (!_runs.TryGetValue(identity.RunId, out var previous) || previous.Identity != identity)
                throw new InvalidDataException("Windows Host run identity changed");
            if (previous.Terminal) return previous;
            var record = previous with
            {
                Terminal = true, State = state, FinishedAt = finishedAt,
                EvidenceRef = evidenceRef, ErrorCode = errorCode
            };
            Append(record);
            _runs[identity.RunId] = record;
            return record;
        }
    }

    internal HostRunRecord? Find(string runId)
    {
        lock (_gate) return _runs.GetValueOrDefault(runId);
    }

    private void Append(HostRunRecord record)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(record);
        if (bytes.Length > 8192 || (File.Exists(_path) && new FileInfo(_path).Length + bytes.Length + 1 > MaxJournalBytes))
            throw new InvalidDataException("Windows Host journal capacity exceeded");
        using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
        stream.Write(bytes);
        stream.WriteByte((byte)'\n');
        stream.Flush(flushToDisk: true);
    }
}
