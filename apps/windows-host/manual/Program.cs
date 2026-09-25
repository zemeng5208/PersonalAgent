using System.Diagnostics;
using System.Runtime.InteropServices;
using PersonalAgent.WindowsHost;

// An opt-in, single-run local diagnostic. Never install or call this from production.
// It only launches a new Notepad process with a new synthetic temporary file.
var expected = $"PA_MOD16_SYNTHETIC_{Guid.NewGuid():N}";
var replacement = expected + "_VERIFIED";
var temporaryFile = Path.Combine(Path.GetTempPath(), $"pa-mod16-{Guid.NewGuid():N}.txt");
var existingProcessIds = Process.GetProcessesByName("notepad").Select(p =>
{
    try { return p.Id; }
    finally { p.Dispose(); }
}).ToHashSet();
Process? launched = null;
try
{
    File.WriteAllText(temporaryFile, expected);
    var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        "System32", "notepad.exe");
    var launchStartUtc = DateTime.UtcNow;
    launched = Process.Start(new ProcessStartInfo(executable)
    {
        UseShellExecute = false,
        ArgumentList = { temporaryFile }
    });
    if (launched is null)
    {
        Console.WriteLine("REFUSED: test process did not start");
        return 2;
    }

    nint window = 0;
    var targetPid = 0;
    DateTime targetStartUtc = default;
    for (var attempt = 0; attempt < 40; attempt++)
    {
        // Only new Notepad processes can receive this synthetic target. An existing
        // process accepting a new tab cannot be bound without inspecting private tabs.
        var candidates = new List<(nint Window, int Pid, DateTime StartUtc)>();
        var ambiguous = false;
        foreach (var process in Process.GetProcessesByName("notepad"))
        {
            using (process)
            {
                if (existingProcessIds.Contains(process.Id)) continue;
                try
                {
                    var startUtc = process.StartTime.ToUniversalTime();
                    if (startUtc < launchStartUtc || !NotepadAction.IsTrustedNotepadProcess(process)) continue;
                    var windows = WindowsForProcess(process.Id);
                    if (windows.Count > 1) ambiguous = true;
                    foreach (var handle in windows) candidates.Add((handle, process.Id, startUtc));
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or
                                           System.ComponentModel.Win32Exception) { ambiguous = true; }
            }
        }
        if (ambiguous || candidates.Count > 1)
        {
            Console.WriteLine("REFUSED: multiple or unverifiable new Notepad windows");
            return 2;
        }
        if (candidates.Count == 1)
        {
            (window, targetPid, targetStartUtc) = candidates[0];
            break;
        }
        await Task.Delay(200);
    }
    if (window == 0)
    {
        Console.WriteLine("REFUSED: no unique new Notepad window; existing windows and tabs were not inspected");
        return 2;
    }
    if (!NotepadAction.HasSingleTabForManualProbe(window, targetPid, targetStartUtc))
    {
        Console.WriteLine("REFUSED: target does not expose exactly one selected Notepad tab");
        return 2;
    }

    Console.WriteLine($"Only the new temporary Notepad window (PID {targetPid}) may be used.");
    Console.WriteLine($"Confirm that its entire visible test text is: {expected}");
    Console.WriteLine("The probe will replace that text in the editor only; it does not save the file.");
    Console.Write("Type CONFIRM to continue, or anything else to stop: ");
    if (Console.ReadLine() != "CONFIRM")
    {
        Console.WriteLine("REFUSED: no manual confirmation");
        return 2;
    }
    Console.WriteLine("Within five seconds, activate that same Notepad window. Do not type into it.");
    await Task.Delay(5000);

    var result = await NotepadAction.ReplaceTextAsync(new ConfirmedNotepadTarget(
        window, targetPid, targetStartUtc, expected, replacement),
        CancellationToken.None);
    Console.WriteLine($"{result.State}: {result.Reason}");
    if (result.State == ActionState.Verified)
        Console.WriteLine("UIA readback matched the synthetic replacement. Confirm visibly; close Notepad without saving.");
    else
        Console.WriteLine("No automatic retry. Inspect the target manually and close it without saving.");
    return result.State == ActionState.Verified ? 0 : 2;
}

catch (Exception)
{
    Console.WriteLine("REFUSED: probe could not verify the launched target; no automatic retry");
    return 2;
}
finally
{
    launched?.Dispose();
    // Never overwrite or delete a file if a user or application changed it.
    try
    {
        if (File.Exists(temporaryFile) && File.ReadAllText(temporaryFile) == expected)
            File.Delete(temporaryFile);
    }
    catch (IOException) { Console.WriteLine("Temporary test file could not be removed; delete it manually."); }
    catch (UnauthorizedAccessException) { Console.WriteLine("Temporary test file could not be removed; delete it manually."); }
}

static List<nint> WindowsForProcess(int pid)
{
    var windows = new List<nint>();
    if (!WindowDiscoveryNative.EnumWindows((handle, _) =>
        {
            if (WindowDiscoveryNative.GetWindowThreadProcessId(handle, out var owner) != 0 && owner == pid &&
                WindowDiscoveryNative.IsWindowVisible(handle) && WindowDiscoveryNative.GetWindow(handle, 4) == 0) // GW_OWNER
                windows.Add(handle);
            return true;
        }, 0)) throw new InvalidOperationException("Window enumeration failed");
    return windows;
}

internal static class WindowDiscoveryNative
{
    internal delegate bool EnumWindowsProc(nint window, nint parameter);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out int processId);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] internal static extern nint GetWindow(nint window, uint command);
}
