/**
 * Source du lanceur Job Object Windows, compilé à la demande par le `csc.exe` de
 * .NET Framework 4.x livré avec Windows (C# 5, aucune dépendance). Reprend le mécanisme
 * démontré par le spike S2 (ADR-003) sans AppContainer : le confinement des fichiers et
 * du réseau reste à S10 ; ici seul compte le contrôle de l'arborescence de processus.
 *
 * Modes :
 *   run --job-name N [--max-procs n] [--cwd d] [--env K=V]... -- exe [args...]
 *     Crée le Job Object nommé N (refusé s'il existe déjà) avec KILL_ON_JOB_CLOSE, sans
 *     breakaway, y assigne `exe` dès sa création (PROC_THREAD_ATTRIBUTE_JOB_LIST), avec un
 *     environnement explicite et trois poignées héritées seulement : stdin (tube alimenté
 *     par ce lanceur), stdout (celle du lanceur) et stderr (NUL). Commandes sur stdin :
 *     `in <texte>` transmet une ligne au processus, `eof` ferme son entrée standard, `kill` termine le job ; la fin de stdin
 *     (contrôleur disparu) termine aussi le job. Quand le processus principal se termine,
 *     ses descendants sont terminés. Événements JSON sur stderr, préfixés par
 *     `mindwake-job ` : `started`, `kill-issued`, `done`.
 *   terminate --job-name N [--timeout-ms n]
 *     Ouvre le job par son nom, le termine et attend zéro processus actif. Une ligne JSON
 *     sur stdout : `{"found":…,"terminated":…,"active":…,"ms":…}`.
 *   query --job-name N
 *     Une ligne JSON sur stdout : `{"found":…,"active":…}`.
 */
export const JOB_LAUNCHER_SOURCE = String.raw`// MIND Wake — lanceur Job Object (généré depuis src/runner/job-launcher-source.ts).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Native
{
    public const uint CREATE_SUSPENDED = 0x4;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const int STARTF_USESTDHANDLES = 0x100;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000D;
    public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
    public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4;
    public const uint JOB_OBJECT_QUERY = 0x0004;
    public const uint JOB_OBJECT_TERMINATE = 0x0008;
    public const int ERROR_ALREADY_EXISTS = 183;
    public const uint HANDLE_FLAG_INHERIT = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT { public IntPtr CompletionKey, CompletionPort; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr ov, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DuplicateHandle(IntPtr sp, IntPtr h, IntPtr tp, out IntPtr dup, uint access, bool inherit, uint opts);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")]
    public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")]
    public static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);
}

static class Launcher
{
    static IntPtr Job;
    static readonly object Gate = new object();
    static bool KillRequested;
    static string KillReason;
    static readonly Stopwatch KillWatch = new Stopwatch();
    static StreamWriter Events;

    static int Main(string[] args)
    {
        Events = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
        Events.AutoFlush = true;
        try
        {
            if (args.Length == 0) throw new ArgumentException("mode manquant");
            string jobName = null; int maxProcs = 0; int timeoutMs = 1000; string cwd = null;
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int i = 1;
            for (; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--") { i++; break; }
                else if (a == "--job-name") jobName = args[++i];
                else if (a == "--max-procs") maxProcs = int.Parse(args[++i]);
                else if (a == "--timeout-ms") timeoutMs = int.Parse(args[++i]);
                else if (a == "--cwd") cwd = args[++i];
                else if (a == "--env") { string kv = args[++i]; int eq = kv.IndexOf('='); env[kv.Substring(0, eq)] = kv.Substring(eq + 1); }
                else throw new ArgumentException("option inconnue: " + a);
            }
            if (string.IsNullOrEmpty(jobName)) throw new ArgumentException("--job-name requis");
            if (args[0] == "query") return Query(jobName);
            if (args[0] == "terminate") return TerminateNamed(jobName, timeoutMs);
            if (args[0] != "run") throw new ArgumentException("mode inconnu: " + args[0]);
            if (i >= args.Length) throw new ArgumentException("commande manquante après --");
            var cmd = new StringBuilder();
            for (int k = i; k < args.Length; k++) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(QuoteArg(args[k])); }
            return Run(jobName, maxProcs, cwd, env, cmd);
        }
        catch (Exception e)
        {
            Emit("{\"event\":\"error\",\"message\":" + Json(e.Message) + "}");
            return 3;
        }
    }

    static int Run(string jobName, int maxProcs, string cwd, SortedDictionary<string, string> env, StringBuilder cmd)
    {
        Job = Native.CreateJobObject(IntPtr.Zero, jobName);
        if (Job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
        if (Marshal.GetLastWin32Error() == Native.ERROR_ALREADY_EXISTS) throw new Exception("job deja existant: " + jobName);
        IntPtr port = Native.CreateIoCompletionPort((IntPtr)(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        SetJobInfo(7, new Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey = (IntPtr)1, CompletionPort = port });
        var lim = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        lim.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if (maxProcs > 0) { lim.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS; lim.BasicLimitInformation.ActiveProcessLimit = (uint)maxProcs; }
        SetJobInfo(9, lim);

        var sa = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr inRead, inWrite;
        if (!Native.CreatePipe(out inRead, out inWrite, ref sa, 0)) throw new Exception("CreatePipe " + Marshal.GetLastWin32Error());
        Native.SetHandleInformation(inWrite, Native.HANDLE_FLAG_INHERIT, 0);
        IntPtr nul = Native.CreateFile("NUL", 0x40000000, 3, ref sa, 3, 0, IntPtr.Zero);
        IntPtr outDup;
        Native.DuplicateHandle(Native.GetCurrentProcess(), Native.GetStdHandle(-11), Native.GetCurrentProcess(), out outDup, 0, true, 2);

        var allocs = new List<IntPtr>();
        IntPtr size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        IntPtr attrs = Marshal.AllocHGlobal(size); allocs.Add(attrs);
        if (!Native.InitializeProcThreadAttributeList(attrs, 2, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());
        IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size); allocs.Add(jobList); Marshal.WriteIntPtr(jobList, Job);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList, IntPtr.Size);
        IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3); allocs.Add(handles);
        Marshal.WriteIntPtr(handles, inRead); Marshal.WriteIntPtr(handles + IntPtr.Size, outDup); Marshal.WriteIntPtr(handles + 2 * IntPtr.Size, nul);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, IntPtr.Size * 3);

        var envSb = new StringBuilder();
        foreach (var kv in env) envSb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        envSb.Append('\0');
        IntPtr envPtr = Marshal.StringToHGlobalUni(envSb.ToString()); allocs.Add(envPtr);

        var si = new Native.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = inRead; si.StartupInfo.hStdOutput = outDup; si.StartupInfo.hStdError = nul;
        si.lpAttributeList = attrs;
        uint flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_NO_WINDOW;
        Native.PROCESS_INFORMATION pi;
        if (!Native.CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, cwd, ref si, out pi))
            throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
        Native.CloseHandle(inRead); Native.CloseHandle(outDup); Native.CloseHandle(nul);
        Native.ResumeThread(pi.hThread);
        Native.CloseHandle(pi.hThread);
        Emit("{\"event\":\"started\",\"pid\":" + pi.dwProcessId + ",\"launcherPid\":" + Process.GetCurrentProcess().Id + "}");

        var childIn = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write);
        var ctl = new Thread(() =>
        {
            var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line == "kill") Kill("command");
                else if (line == "eof")
                {
                    try { childIn.Dispose(); } catch (Exception) { }
                }
                else if (line.StartsWith("in "))
                {
                    try { byte[] b = new UTF8Encoding(false).GetBytes(line.Substring(3) + "\n"); childIn.Write(b, 0, b.Length); childIn.Flush(); }
                    catch (Exception) { }
                }
            }
            Kill("controller-eof");
        });
        ctl.IsBackground = true; ctl.Start();

        uint mainExit = 259;
        while (true)
        {
            uint msg; UIntPtr key; IntPtr ov;
            bool got = Native.GetQueuedCompletionStatus(port, out msg, out key, out ov, 10);
            if (got && msg == Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) break;
            if (Native.WaitForSingleObject(pi.hProcess, 0) == 0)
            {
                Native.GetExitCodeProcess(pi.hProcess, out mainExit);
                Kill("main-exited");
            }
            if (QueryAccounting(Job).ActiveProcesses == 0) break;
        }
        double killMs = -1;
        lock (Gate) { if (KillRequested) { KillWatch.Stop(); killMs = KillWatch.Elapsed.TotalMilliseconds; } }
        Native.GetExitCodeProcess(pi.hProcess, out mainExit);
        var acct = QueryAccounting(Job);
        Emit("{\"event\":\"done\",\"mainExitCode\":" + mainExit + ",\"killReason\":" + Json(KillReason) +
             ",\"killToZeroMs\":" + killMs.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) +
             ",\"totalProcesses\":" + acct.TotalProcesses + ",\"activeProcesses\":" + acct.ActiveProcesses + "}");
        foreach (var p in allocs) Marshal.FreeHGlobal(p);
        return 0;
    }

    static void Kill(string reason)
    {
        lock (Gate)
        {
            if (KillRequested) return;
            KillRequested = true; KillReason = reason; KillWatch.Restart();
        }
        bool ok = Native.TerminateJobObject(Job, 0xC0DE);
        Emit("{\"event\":\"kill-issued\",\"reason\":" + Json(reason) + ",\"ok\":" + (ok ? "true" : "false") + "}");
    }

    static int Query(string jobName)
    {
        IntPtr job = Native.OpenJobObject(Native.JOB_OBJECT_QUERY, false, jobName);
        if (job == IntPtr.Zero) { Console.Out.WriteLine("{\"found\":false,\"active\":0}"); return 0; }
        uint active = QueryAccounting(job).ActiveProcesses;
        Native.CloseHandle(job);
        Console.Out.WriteLine("{\"found\":true,\"active\":" + active + "}");
        return 0;
    }

    static int TerminateNamed(string jobName, int timeoutMs)
    {
        var watch = Stopwatch.StartNew();
        IntPtr job = Native.OpenJobObject(Native.JOB_OBJECT_TERMINATE | Native.JOB_OBJECT_QUERY, false, jobName);
        if (job == IntPtr.Zero) { Console.Out.WriteLine("{\"found\":false,\"terminated\":false,\"active\":0,\"ms\":0}"); return 0; }
        bool ok = Native.TerminateJobObject(job, 0xC0DE);
        uint active = QueryAccounting(job).ActiveProcesses;
        while (active > 0 && watch.ElapsedMilliseconds < timeoutMs) { Thread.Sleep(1); active = QueryAccounting(job).ActiveProcesses; }
        Native.CloseHandle(job);
        Console.Out.WriteLine("{\"found\":true,\"terminated\":" + (ok ? "true" : "false") + ",\"active\":" + active +
            ",\"ms\":" + watch.Elapsed.TotalMilliseconds.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + "}");
        return 0;
    }

    static void Update(IntPtr attrs, IntPtr attr, IntPtr value, int size)
    {
        if (!Native.UpdateProcThreadAttribute(attrs, 0, attr, value, (IntPtr)size, IntPtr.Zero, IntPtr.Zero))
            throw new Exception("UpdateProcThreadAttribute " + Marshal.GetLastWin32Error());
    }

    static void SetJobInfo<T>(int cls, T info)
    {
        int n = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(n);
        try
        {
            Marshal.StructureToPtr(info, p, false);
            if (!Native.SetInformationJobObject(Job, cls, p, n)) throw new Exception("SetInformationJobObject " + cls + " " + Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(p); }
    }

    static Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION QueryAccounting(IntPtr job)
    {
        int n = Marshal.SizeOf(typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); IntPtr p = Marshal.AllocHGlobal(n);
        try
        {
            Native.QueryInformationJobObject(job, 1, p, n, IntPtr.Zero);
            return (Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(p, typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        }
        finally { Marshal.FreeHGlobal(p); }
    }

    static void Emit(string json) { lock (Events) Events.WriteLine("mindwake-job " + json); }

    static string Json(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // Règles de découpage de la ligne de commande de la CRT Microsoft.
    static string QuoteArg(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a)
        {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1); }
            else { sb.Append('\\', bs); }
            bs = 0; sb.Append(c);
        }
        sb.Append('\\', bs * 2);
        return sb.Append('"').ToString();
    }
}
`;
