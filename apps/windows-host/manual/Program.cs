using System.Diagnostics;
using System.Runtime.InteropServices;
using PersonalAgent.WindowsHost;

// An opt-in, single-run local diagnostic. Never install or call this from production.
// It only launches a new Notepad process with a new synthetic temporary file.
var expected = $"PA_MOD16_SYNTHETIC_{Guid.NewGuid():N}";
var replacement = expected + "_VERIFIED";
var temporaryFile = Path.Combine(Path.GetTempPath(), $"pa-mod16-{Guid.NewGuid():N}.txt");
Process? launched = null;
try
{
    var existingProcesses = new Dictionary<int, DateTime>();
    var existingWindows = new HashSet<(nint Window, int Pid, DateTime StartUtc)>();
    foreach (var process in Process.GetProcessesByName("notepad"))
    {
        using (process)
        {
            var startUtc = process.StartTime.ToUniversalTime();
            existingProcesses.Add(process.Id, startUtc);
            // Snapshot all top-level handles, including hidden and owned windows.
            // A pre-existing window becoming visible is never a new target.
            foreach (var handle in WindowsForProcess(process.Id, visibleUnownedOnly: false))
                existingWindows.Add((handle, process.Id, startUtc));
        }
    }
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
        // A new window may belong to an existing Notepad PID, but an old HWND
        // accepting a new tab is never eligible. No title or tab content is read.
        var candidates = new List<(nint Window, int Pid, DateTime StartUtc)>();
        var unverifiable = false;
        foreach (var process in Process.GetProcessesByName("notepad"))
        {
            using (process)
            {
                try
                {
                    var startUtc = process.StartTime.ToUniversalTime();
                    if (startUtc < launchStartUtc &&
                        (!existingProcesses.TryGetValue(process.Id, out var originalStart) || originalStart != startUtc))
                        continue;
                    foreach (var handle in WindowsForProcess(process.Id, visibleUnownedOnly: true))
                    {
                        if (existingWindows.Contains((handle, process.Id, startUtc))) continue;
                        if (!NotepadAction.IsTrustedNotepadProcess(process)) unverifiable = true;
                        else candidates.Add((handle, process.Id, startUtc));
                    }
                }
                catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or
                                           System.ComponentModel.Win32Exception) { unverifiable = true; }
            }
        }
        if (unverifiable)
        {
            Console.WriteLine("REFUSED: new Notepad window identity could not be verified");
            return 2;
        }
        if (candidates.Count > 1)
        {
            Console.WriteLine("REFUSED: multiple new Notepad windows");
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
        Console.WriteLine("REFUSED: no new visible Notepad window; existing windows and tabs were not inspected");
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

static List<nint> WindowsForProcess(int pid, bool visibleUnownedOnly)
{
    var windows = new List<nint>();
    if (!WindowDiscoveryNative.EnumWindows((handle, _) =>
        {
            if (WindowDiscoveryNative.GetWindowThreadProcessId(handle, out var owner) != 0 && owner == pid &&
                (!visibleUnownedOnly ||
                 (WindowDiscoveryNative.IsWindowVisible(handle) && WindowDiscoveryNative.GetWindow(handle, 4) == 0))) // GW_OWNER
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
