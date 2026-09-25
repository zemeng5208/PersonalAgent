using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Security.Principal;
using System.Text;
using System.Windows.Automation;

[assembly: InternalsVisibleTo("WindowsHost.Timing")]
[assembly: InternalsVisibleTo("ManualNotepadProbe")]

namespace PersonalAgent.WindowsHost;

// This public DTO has no authorization semantics. A future trusted Runtime adapter must
// consume a specific approval before invoking this library.
public sealed record ConfirmedNotepadTarget(
    nint WindowHandle,
    int ProcessId,
    DateTime ProcessStartUtc,
    string ExpectedText,
    string ReplacementText);

public enum ActionState { Rejected, Verified, ResultUnknown }

public sealed record ActionResult(ActionState State, string Reason);

public static class NotepadAction
{
    private const int MaxTextLength = 4096;
    private static readonly SemaphoreSlim InputLock = new(1, 1);

    public static async Task<ActionResult> ReplaceTextAsync(
        ConfirmedNotepadTarget target, CancellationToken cancellationToken)
    {
        if (target is null || target.WindowHandle == 0 || target.ProcessId <= 0 ||
            target.ProcessStartUtc.Kind != DateTimeKind.Utc ||
            target.ExpectedText is null || target.ReplacementText is null ||
            target.ExpectedText.Length > MaxTextLength || target.ReplacementText.Length > MaxTextLength ||
            target.ExpectedText == target.ReplacementText)
            return new(ActionState.Rejected, "Invalid or unchanged bounded request");

        if (cancellationToken.IsCancellationRequested)
            return new(ActionState.Rejected, "Cancelled before execution");

        try { await InputLock.WaitAsync(cancellationToken).ConfigureAwait(false); }
        catch (OperationCanceledException) { return new(ActionState.Rejected, "Cancelled while waiting for input lock"); }

        var mutationStarted = false;
        try
        {
            // Reject an elevated host: ordinary user authority is an invariant, not a fallback.
            using var identity = WindowsIdentity.GetCurrent();
            if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                return new(ActionState.Rejected, "Elevated host is not supported");

            // Baseline precedes all UIA reads: a user edit during discovery must not
            // become the new baseline for an otherwise matching expected value.
            var inputTick = LastInputTick();
            if (!IsSameForegroundTarget(target))
                return new(ActionState.Rejected, "Confirmed target is no longer foreground");

            var root = AutomationElement.FromHandle(target.WindowHandle);
            if (root.Current.ProcessId != target.ProcessId)
                return new(ActionState.Rejected, "Window identity changed");
            if (!TryGetOnlyTab(root, target.ProcessId, out var selectedTab))
                return new(ActionState.Rejected, "Exactly one Notepad tab is required");
            var edits = root.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            if (edits.Count != 1 || !edits[0].TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
                return new(ActionState.Rejected, "Exactly one editable UIA text control is required");
            var edit = edits[0];
            var value = (ValuePattern)pattern;
            if (!edit.Current.IsEnabled || value.Current.IsReadOnly)
                return new(ActionState.Rejected, "Target text changed or is not editable");

            cancellationToken.ThrowIfCancellationRequested();
            if (!PrewriteStable(inputTick, target.ExpectedText, () => value.Current.Value,
                    LastInputTick, () => IsSameForegroundTarget(target)))
                return new(ActionState.Rejected, "User input or target text changed before execution");
            cancellationToken.ThrowIfCancellationRequested();
            // Rebind the selected tab and edit immediately before SetValue. UIA has
            // no atomic compare-and-set; this only narrows the remaining race.
            var prewriteRoot = AutomationElement.FromHandle(target.WindowHandle);
            if (prewriteRoot.Current.ProcessId != target.ProcessId ||
                !TryGetOnlyTab(prewriteRoot, target.ProcessId, out var prewriteTab) ||
                !SameElement(selectedTab, prewriteTab))
                return new(ActionState.Rejected, "Target tab changed before execution");
            var prewriteEdits = prewriteRoot.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            if (prewriteEdits.Count != 1 || !prewriteEdits[0].Equals(edit) ||
                !edit.Current.IsEnabled || value.Current.IsReadOnly ||
                !PrewriteStable(inputTick, target.ExpectedText, () => value.Current.Value,
                    LastInputTick, () => IsSameForegroundTarget(target)))
                return new(ActionState.Rejected, "Target editor changed before execution");
            cancellationToken.ThrowIfCancellationRequested();

            // SetValue can mutate before returning or throwing. Any subsequent failure is unknown.
            mutationStarted = true;
            value.SetValue(target.ReplacementText);
            if (cancellationToken.IsCancellationRequested || !IsSameForegroundTarget(target) ||
                LastInputTick() != inputTick)
                return new(ActionState.ResultUnknown, "Interrupted after text mutation; read back before retry");

            // Read the target again. A successful UIA call alone is never proof of the result.
            var reread = AutomationElement.FromHandle(target.WindowHandle);
            if (reread.Current.ProcessId != target.ProcessId ||
                !TryGetOnlyTab(reread, target.ProcessId, out var readbackTab) ||
                !SameElement(selectedTab, readbackTab))
                return new(ActionState.ResultUnknown, "Target tab changed during readback");
            var currentEdits = reread.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            if (currentEdits.Count != 1 || !currentEdits[0].Equals(edit) ||
                !currentEdits[0].TryGetCurrentPattern(ValuePattern.Pattern, out var currentPattern) ||
                ((ValuePattern)currentPattern).Current.Value != target.ReplacementText)
                return new(ActionState.ResultUnknown, "Target readback did not confirm replacement");
            if (!IsSameForegroundTarget(target) || LastInputTick() != inputTick ||
                cancellationToken.IsCancellationRequested)
                return new(ActionState.ResultUnknown, "Target or user input changed during readback");
            return new(ActionState.Verified, "Target UIA text readback confirmed");
        }
        catch (OperationCanceledException)
        {
            return new(mutationStarted ? ActionState.ResultUnknown : ActionState.Rejected,
                mutationStarted ? "Cancelled after mutation; reconcile before retry" : "Cancelled before mutation");
        }
        catch (Exception)
        {
            // UIA and process APIs may throw COM, Win32 or provider-specific exceptions.
            // Never leak target text, process path, window title or exception messages.
            return new(mutationStarted ? ActionState.ResultUnknown : ActionState.Rejected,
                mutationStarted ? "UIA failure after mutation; reconcile before retry" : "Target validation failed");
        }
        finally { InputLock.Release(); }
    }

    internal static bool PrewriteStable(uint baseline, string expectedText,
        Func<string> readText, Func<uint> readInputTick, Func<bool> sameTarget)
    {
        if (readText() != expectedText) return false;
        if (readInputTick() != baseline || !sameTarget()) return false;
        // A programmatic UIA edit need not update the last-user-input tick.
        return readText() == expectedText && readInputTick() == baseline && sameTarget();
    }

    private static bool IsSameForegroundTarget(ConfirmedNotepadTarget target)
    {
        if (GetForegroundWindow() != target.WindowHandle ||
            GetWindowThreadProcessId(target.WindowHandle, out var pid) == 0 || pid != target.ProcessId)
            return false;
        try
        {
            using var process = Process.GetProcessById(target.ProcessId);
            return IsTrustedNotepadProcess(process) && process.StartTime.ToUniversalTime() == target.ProcessStartUtc;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or
                                   System.ComponentModel.Win32Exception)
        { return false; }
    }

    internal static bool IsTrustedNotepadProcess(Process process)
    {
        if (!string.Equals(process.ProcessName, "notepad", StringComparison.OrdinalIgnoreCase)) return false;
        var packageResult = ReadPackageFamily(process, out var family);
        if (packageResult == 0)
            return string.Equals(family, "Microsoft.WindowsNotepad_8wekyb3d8bbwe",
                StringComparison.OrdinalIgnoreCase);
        if (packageResult != 15700) return false; // APPMODEL_ERROR_NO_PACKAGE
        var trustedPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "notepad.exe");
        return string.Equals(process.MainModule?.FileName, trustedPath, StringComparison.OrdinalIgnoreCase);
    }

    private static int ReadPackageFamily(Process process, out string? family)
    {
        family = null;
        var handle = OpenProcess(0x1000, false, process.Id); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == 0) return -1;
        try
        {
            var familyLength = 0u;
            var packageResult = GetPackageFamilyName(handle, ref familyLength, null);
            if (packageResult == 122 && familyLength is > 1 and <= 256)
            {
                var buffer = new StringBuilder((int)familyLength);
                packageResult = GetPackageFamilyName(handle, ref familyLength, buffer);
                if (packageResult == 0) family = buffer.ToString();
            }
            return packageResult;
        }
        finally { CloseHandle(handle); }
    }

    private static bool SameElement(AutomationElement? first, AutomationElement? second) =>
        first is null ? second is null : first.Equals(second);

    private static bool TryGetOnlyTab(AutomationElement root, int pid, out AutomationElement? selectedTab)
    {
        selectedTab = null;
        var tabs = root.FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Tab));
        if (tabs.Count == 0)
        {
            using var process = Process.GetProcessById(pid);
            return ReadPackageFamily(process, out _) == 15700; // Only classic Notepad may lack tabs.
        }
        if (tabs.Count != 1) return false;
        var items = tabs[0].FindAll(TreeScope.Children,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
        if (items.Count != 1 ||
            !items[0].TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selected) ||
            !((SelectionItemPattern)selected).Current.IsSelected) return false;
        selectedTab = items[0];
        return true;
    }

    private static uint LastInputTick()
    {
        var info = new LastInputInfo { Size = (uint)Marshal.SizeOf<LastInputInfo>() };
        if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("Input state unavailable");
        return info.TickCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo { public uint Size; public uint TickCount; }

    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out int processId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFamilyName(nint process, ref uint length, StringBuilder? familyName);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
}
