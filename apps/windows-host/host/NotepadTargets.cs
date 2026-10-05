using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace PersonalAgent.WindowsHost.Service;

internal sealed record ObservedNotepadTarget(
    string Reference, nint Window, int ProcessId, DateTime StartUtc, DateTime ExpiresUtc);

internal static class NotepadTargetLease
{
    // UIA metadata lookup may block; the same lease still governs its result.
    internal static bool IsCurrent(DateTime expiresUtc, Func<bool> validate,
        Func<DateTime>? utcNow = null)
    {
        var now = utcNow ?? (() => DateTime.UtcNow);
        return expiresUtc > now() && validate() && expiresUtc > now();
    }
}

// Observations never inspect a title, tab label or editor value. Old HWNDs remain
// excluded even if Notepad later opens the requested file as a tab within them.
internal sealed class NotepadTargets
{
    private readonly HashSet<(nint Window, int Pid, DateTime StartUtc)> _existing = [];
    private readonly Dictionary<string, ObservedNotepadTarget> _current = new(StringComparer.Ordinal);
    private readonly bool _baselineComplete = true;

    internal NotepadTargets(Func<Process[]>? baselineProcesses = null)
    {
        var currentSession = Process.GetCurrentProcess().SessionId;
        foreach (var process in (baselineProcesses ?? (() => Process.GetProcessesByName("notepad")))())
        {
            using (process)
            {
                try
                {
                    if (process.SessionId != currentSession) continue;
                    _ = process.SafeHandle; // Bind subsequent queries to the original process.
                    if (process.HasExited) throw new InvalidOperationException("Baseline process exited");
                    var start = process.StartTime.ToUniversalTime();
                    foreach (var handle in WindowsForProcess(process.Id, visibleUnownedOnly: false))
                        _existing.Add((handle, process.Id, start));
                    if (process.HasExited) throw new InvalidOperationException("Baseline process exited");
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or
                                           System.ComponentModel.Win32Exception)
                {
                    // A skipped old window could become queryable later and be
                    // mistaken for a new target. This session cannot observe
                    // safely unless its entire baseline was established.
                    _baselineComplete = false;
                }
            }
        }
    }

    internal (ObservedNotepadTarget? Target, string? ErrorCode) Observe(DateTime deadlineUtc)
    {
        var now = DateTime.UtcNow;
        if (deadlineUtc <= now) return (null, "TIMEOUT");
        if (!_baselineComplete) return (null, "UNAUTHORIZED");
        var currentSession = Process.GetCurrentProcess().SessionId;
        var candidates = new List<(nint Window, int Pid, DateTime StartUtc)>();
        var unverifiable = false;
        foreach (var process in Process.GetProcessesByName("notepad"))
        {
            using (process)
            {
                try
                {
                    if (process.SessionId != currentSession) continue;
                    _ = process.SafeHandle;
                    if (process.HasExited) throw new InvalidOperationException("Observed process exited");
                    var start = process.StartTime.ToUniversalTime();
                    foreach (var handle in WindowsForProcess(process.Id, visibleUnownedOnly: true))
                    {
                        if (_existing.Contains((handle, process.Id, start))) continue;
                        if (!NotepadAction.IsTrustedNotepadProcess(process)) unverifiable = true;
                        else candidates.Add((handle, process.Id, start));
                    }
                    if (process.HasExited) unverifiable = true;
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or
                                           System.ComponentModel.Win32Exception)
                {
                    unverifiable = true;
                }
            }
        }
        if (unverifiable) return (null, "UNAUTHORIZED");
        if (candidates.Count == 0) return (null, "NOT_FOUND");
        if (candidates.Count != 1) return (null, "TARGET_AMBIGUOUS");
        if (candidates[0].Window != GetForegroundWindow()) return (null, "TARGET_STALE");
        var candidate = candidates[0];
        var expires = deadlineUtc < now.AddSeconds(30) ? deadlineUtc : now.AddSeconds(30);
        string? errorCode = null;
        var current = NotepadTargetLease.IsCurrent(expires, () =>
        {
            var result = NotepadAction.CheckSingleTabTarget(
                candidate.Window, candidate.Pid, candidate.StartUtc);
            errorCode = result.ErrorCode;
            return result.Success;
        });
        if (!current) return (null, expires <= DateTime.UtcNow ? "TIMEOUT" : errorCode ?? "TARGET_STALE");
        var target = new ObservedNotepadTarget(
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            candidate.Window, candidate.Pid, candidate.StartUtc, expires);
        _current.Add(target.Reference, target);
        return (target, null);
    }

    internal ObservedNotepadTarget? Resolve(string targetRef)
    {
        if (!_current.TryGetValue(targetRef, out var target))
            return null;
        return NotepadTargetLease.IsCurrent(target.ExpiresUtc, () =>
            GetForegroundWindow() == target.Window &&
            GetWindowThreadProcessId(target.Window, out var pid) != 0 && pid == target.ProcessId &&
            NotepadAction.HasSingleTabForManualProbe(target.Window, target.ProcessId, target.StartUtc))
            ? target : null;
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
