using PersonalAgent.WindowsHost;

const string expected = "synthetic";
uint tick = 10;
var readCount = 0;
var permitted = NotepadAction.PrewriteStable(tick, expected,
    () =>
    {
        readCount++;
        if (readCount == 1) tick = 11; // User input interleaves after expected-value read.
        return expected;
    },
    () => tick,
    () => true);
if (permitted || readCount != 1)
    throw new Exception("Input after expected-value read must refuse mutation");

tick = 10;
readCount = 0;
var text = expected;
permitted = NotepadAction.PrewriteStable(tick, expected,
    () =>
    {
        readCount++;
        if (readCount == 2) text = "programmatic-change"; // UIA change without input tick.
        return text;
    },
    () => tick,
    () => true);
if (permitted || readCount != 2)
    throw new Exception("Programmatic target change must refuse mutation");

Console.WriteLine("PASS: prewrite user input and programmatic edit rejected");
