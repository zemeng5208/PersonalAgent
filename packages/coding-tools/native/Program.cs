using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace PersonalAgent.CodingTools.Native;

internal static class Program
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const int STD_INPUT_HANDLE = -10;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryLimit;
        public UIntPtr PeakJobMemoryLimit;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInformationClass,
        IntPtr lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string? lpApplicationName,
        string lpCommandLine,
        ref SECURITY_ATTRIBUTES lpProcessAttributes,
        ref SECURITY_ATTRIBUTES lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    public static int Main(string[] args)
    {
        string? cwd = null;
        string? exe = null;
        int targetArgsIndex = -1;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--" && targetArgsIndex < 0)
            {
                targetArgsIndex = i + 1;
                break;
            }
            if (args[i] == "--cwd" && i + 1 < args.Length)
            {
                cwd = args[++i];
            }
            else if (args[i] == "--exe" && i + 1 < args.Length)
            {
                exe = args[++i];
            }
        }

        if (string.IsNullOrEmpty(exe))
        {
            Console.Error.WriteLine("WindowsJobProcessHost: --exe <target> is required.");
            return 1;
        }

        if (!File.Exists(exe))
        {
            Console.Error.WriteLine($"WindowsJobProcessHost: Target executable does not exist: {exe}");
            return 1;
        }

        if (!string.IsNullOrEmpty(cwd) && !Directory.Exists(cwd))
        {
            Console.Error.WriteLine($"WindowsJobProcessHost: Working directory does not exist: {cwd}");
            return 1;
        }

        // 1. Create Job Object with KILL_ON_JOB_CLOSE
        IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            Console.Error.WriteLine($"WindowsJobProcessHost: CreateJobObjectW failed with error {err}");
            return 1;
        }

        try
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                {
                    LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                }
            };

            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr infoPtr = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, infoPtr, false);
                if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, infoPtr, (uint)length))
                {
                    int err = Marshal.GetLastWin32Error();
                    Console.Error.WriteLine($"WindowsJobProcessHost: SetInformationJobObject failed with error {err}");
                    return 1;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(infoPtr);
            }

            // 2. Build target command line
            var sb = new StringBuilder();
            sb.Append(QuoteArgument(exe));

            if (targetArgsIndex >= 0)
            {
                for (int i = targetArgsIndex; i < args.Length; i++)
                {
                    sb.Append(' ');
                    sb.Append(QuoteArgument(args[i]));
                }
            }

            // 3. Create inheritable pipes for stdout and stderr
            var sa = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                bInheritHandle = true,
                lpSecurityDescriptor = IntPtr.Zero
            };

            if (!CreatePipe(out IntPtr hStdOutRead, out IntPtr hStdOutWrite, ref sa, 0))
            {
                int err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine($"WindowsJobProcessHost: CreatePipe for stdout failed with error {err}");
                return 1;
            }

            if (!CreatePipe(out IntPtr hStdErrRead, out IntPtr hStdErrWrite, ref sa, 0))
            {
                int err = Marshal.GetLastWin32Error();
                CloseHandle(hStdOutRead);
                CloseHandle(hStdOutWrite);
                Console.Error.WriteLine($"WindowsJobProcessHost: CreatePipe for stderr failed with error {err}");
                return 1;
            }

            // Ensure read handles are not inherited by child process
            if (!SetHandleInformation(hStdOutRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(hStdErrRead, HANDLE_FLAG_INHERIT, 0))
            {
                int err = Marshal.GetLastWin32Error();
                CloseHandle(hStdOutRead);
                CloseHandle(hStdOutWrite);
                CloseHandle(hStdErrRead);
                CloseHandle(hStdErrWrite);
                Console.Error.WriteLine($"WindowsJobProcessHost: SetHandleInformation failed with error {err}");
                return 1;
            }

            var pi = new PROCESS_INFORMATION();
            var si = new STARTUPINFO
            {
                cb = Marshal.SizeOf(typeof(STARTUPINFO)),
                dwFlags = (int)STARTF_USESTDHANDLES,
                hStdInput = GetStdHandle(STD_INPUT_HANDLE),
                hStdOutput = hStdOutWrite,
                hStdError = hStdErrWrite
            };

            var procSa = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                bInheritHandle = false,
                lpSecurityDescriptor = IntPtr.Zero
            };
            var threadSa = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                bInheritHandle = false,
                lpSecurityDescriptor = IntPtr.Zero
            };

            // 4. CreateProcessW with CREATE_SUSPENDED and CREATE_NO_WINDOW
            bool created = CreateProcessW(
                lpApplicationName: exe,
                lpCommandLine: sb.ToString(),
                lpProcessAttributes: ref procSa,
                lpThreadAttributes: ref threadSa,
                bInheritHandles: true,
                dwCreationFlags: CREATE_SUSPENDED | CREATE_NO_WINDOW,
                lpEnvironment: IntPtr.Zero,
                lpCurrentDirectory: cwd,
                lpStartupInfo: ref si,
                lpProcessInformation: out pi);

            // Close write ends in the host helper process immediately so EOF works
            CloseHandle(hStdOutWrite);
            CloseHandle(hStdErrWrite);

            if (!created)
            {
                int err = Marshal.GetLastWin32Error();
                CloseHandle(hStdOutRead);
                CloseHandle(hStdErrRead);
                Console.Error.WriteLine($"WindowsJobProcessHost: CreateProcessW failed with error {err}");
                return 1;
            }

            // 5. Invariant: Assign process to Job Object BEFORE resuming thread!
            if (!AssignProcessToJobObject(hJob, pi.hProcess))
            {
                int err = Marshal.GetLastWin32Error();
                // Assignment failed: terminate suspended process immediately to prevent runaway
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hStdOutRead);
                CloseHandle(hStdErrRead);
                Console.Error.WriteLine($"WindowsJobProcessHost: AssignProcessToJobObject failed with error {err}");
                return 1;
            }

            // 6. Resume the thread now that it is safely inside the Job Object
            uint resumeResult = ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
            if (resumeResult == unchecked((uint)-1))
            {
                int err = Marshal.GetLastWin32Error();
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hProcess);
                CloseHandle(hStdOutRead);
                CloseHandle(hStdErrRead);
                Console.Error.WriteLine($"WindowsJobProcessHost: ResumeThread failed with error {err}");
                return 1;
            }

            // 7. Asynchronously pump stdout and stderr to host streams
            var stdoutTask = Task.Run(() =>
            {
                try
                {
                    using var stream = new FileStream(new SafeFileHandle(hStdOutRead, true), FileAccess.Read);
                    using var stdout = Console.OpenStandardOutput();
                    stream.CopyTo(stdout);
                }
                catch {}
            });

            var stderrTask = Task.Run(() =>
            {
                try
                {
                    using var stream = new FileStream(new SafeFileHandle(hStdErrRead, true), FileAccess.Read);
                    using var stderr = Console.OpenStandardError();
                    stream.CopyTo(stderr);
                }
                catch {}
            });

            // 8. Wait for process exit
            WaitForSingleObject(pi.hProcess, INFINITE);
            uint exitCode = 1;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode))
            {
                int err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine($"WindowsJobProcessHost: GetExitCodeProcess failed with error {err}");
                exitCode = 1;
            }
            CloseHandle(pi.hProcess);

            // A child can outlive the root and keep inherited output handles open.
            // End this recipe's job before draining pipes, so normal completion
            // cannot hang until the outer deadline or leave background workers.
            if (!CloseHandle(hJob))
            {
                Console.Error.WriteLine("WindowsJobProcessHost: Job close failed");
                return 1;
            }
            hJob = IntPtr.Zero;
            Task.WaitAll(stdoutTask, stderrTask);

            return (int)exitCode;
        }
        finally
        {
            if (hJob != IntPtr.Zero) CloseHandle(hJob);
        }
    }

    private static string QuoteArgument(string arg)
    {
        if (string.IsNullOrEmpty(arg)) return "\"\"";
        if (!arg.Contains(' ') && !arg.Contains('\t') && !arg.Contains('\n') && !arg.Contains('\r') && !arg.Contains('"'))
        {
            return arg;
        }

        var sb = new StringBuilder();
        sb.Append('"');
        for (int i = 0; i < arg.Length; i++)
        {
            int backslashes = 0;
            while (i < arg.Length && arg[i] == '\\')
            {
                backslashes++;
                i++;
            }
            if (i == arg.Length)
            {
                sb.Append('\\', backslashes * 2);
                break;
            }
            if (arg[i] == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashes);
                sb.Append(arg[i]);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
