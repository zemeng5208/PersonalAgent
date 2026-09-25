using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace PersonalAgent.WindowsHost.Service;

internal sealed record ObservedNotepadTarget(
    string Reference, nint Window, int ProcessId, DateTime StartUtc, DateTime ExpiresUtc);

// Observations never inspect a title, tab label or editor value. Old HWNDs remain
// excluded even if Notepad later opens the requested file as a tab within them.
internal sealed class NotepadTargets
{
    private readonly HashSet<(nint Window, int Pid, DateTime StartUtc)> _existing = [];
    private readonly Dictionary<string, ObservedNotepadTarget> _current = new(StringComparer.Ordinal);

    internal NotepadTargets()
    {
        foreach (var process in Process.GetProcessesByName("notepad"))
        {
            using (process)
            {
                var start = process.StartTime.ToUniversalTime();
                foreach (var handle in WindowsForProcess(process.Id, visibleUnownedOnly: false))
                    _existing.Add((handle, process.Id, start));
            }
        }
    }

    internal (ObservedNotepadTarget? Target, string? ErrorCode) Observe(DateTime deadlineUtc)
    {
        var now = DateTime.UtcNow;
        if (deadlineUtc <= now) return (null, "TIMEOUT");
        var candidates = new List<(nint Window, int Pid, DateTime StartUtc)>();
        foreach (var process in Process.GetProcessesByName("notepad"))
        {
            using (process)
            {
                var start = process.StartTime.ToUniversalTime();
                foreach (var handle in WindowsForProcess(process.Id, visibleUnownedOnly: true))
                {
                    if (!_existing.Contains((handle, process.Id, start)))
                        candidates.Add((handle, process.Id, start));
                }
            }
        }
        if (candidates.Count == 0) return (null, "NOT_FOUND");
        if (candidates.Count != 1) return (null, "TARGET_AMBIGUOUS");
        if (candidates[0].Window != GetForegroundWindow()) return (null, "TARGET_STALE");
        var candidate = candidates[0];
        if (!NotepadAction.HasSingleTabForManualProbe(
                candidate.Window, candidate.Pid, candidate.StartUtc)) return (null, "TARGET_STALE");
        var expires = deadlineUtc < now.AddSeconds(30) ? deadlineUtc : now.AddSeconds(30);
        var target = new ObservedNotepadTarget(
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            candidate.Window, candidate.Pid, candidate.StartUtc, expires);
        _current.Add(target.Reference, target);
        return (target, null);
    }

    internal ObservedNotepadTarget? Resolve(string targetRef)
    {
        if (!_current.TryGetValue(targetRef, out var target) || target.ExpiresUtc <= DateTime.UtcNow)
            return null;
        if (GetForegroundWindow() != target.Window ||
            GetWindowThreadProcessId(target.Window, out var pid) == 0 || pid != target.ProcessId ||
            !NotepadAction.HasSingleTabForManualProbe(target.Window, target.ProcessId, target.StartUtc))
            return null;
        return target;
    }

    internal void Clear() => _current.Clear();

    private static List<nint> WindowsForProcess(int pid, bool visibleUnownedOnly)
    {
        var windows = new List<nint>();
        if (!EnumWindows((handle, _) =>
            {
                if (GetWindowThreadProcessId(handle, out var owner) != 0 && owner == pid &&
                    (!visibleUnownedOnly || (IsWindowVisible(handle) && GetWindow(handle, 4) == 0)))
                    windows.Add(handle);
                return true;
            }, 0)) throw new InvalidOperationException("Notepad window enumeration failed");
        return windows;
    }

    private delegate bool EnumWindowsProc(nint window, nint parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out int processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint window, uint command);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
}
