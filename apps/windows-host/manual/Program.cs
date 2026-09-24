using System.Diagnostics;
using PersonalAgent.WindowsHost;

// An opt-in, single-run local diagnostic. Never install or call this from production.
// It only launches a new Notepad process with a new synthetic temporary file.
var expected = $"PA_MOD16_SYNTHETIC_{Guid.NewGuid():N}";
var replacement = expected + "_VERIFIED";
var temporaryFile = Path.Combine(Path.GetTempPath(), $"pa-mod16-{Guid.NewGuid():N}.txt");
Process? launched = null;
try
{
    File.WriteAllText(temporaryFile, expected);
    var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        "System32", "notepad.exe");
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
    for (var attempt = 0; attempt < 40; attempt++)
    {
        launched.Refresh();
        if (launched.HasExited) break;
        window = launched.MainWindowHandle;
        if (window != 0) break;
        await Task.Delay(200);
    }
    if (window == 0)
    {
        Console.WriteLine("REFUSED: launched process did not expose its own window; no other Notepad window is searched");
        return 2;
    }

    Console.WriteLine($"Only the new temporary Notepad window (PID {launched.Id}) may be used.");
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
        window, launched.Id, launched.StartTime.ToUniversalTime(), expected, replacement),
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
