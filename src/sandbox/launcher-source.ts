/**
 * Source du lanceur confiné Windows (S10, ADR-003), compilé à la demande par le `csc.exe`
 * de .NET Framework 4.x livré avec Windows (C# 5, aucune dépendance, aucun binaire
 * téléchargé). Construction : voir `build.ts` et le README de ce dossier.
 *
 * Modes (une ligne JSON sur stdout pour les modes de gestion) :
 *   profile-create | profile-delete | profile-status --profile P
 *     Profil AppContainer dédié (sans capacité) ; l'état vérifie la clé HKCU de
 *     correspondance et le dossier %LOCALAPPDATA%PackagesP.
 *   revoke | acl-status --profile P [--rw d]... [--ro d]...
 *     Retire (ou constate) les ACE explicites du SID du conteneur sur ces racines.
 *   run --profile P --job-name N [--rw d]... [--ro d]... [--env K=V]... [--cwd d]
 *       [--max-procs n] [--job-mem-mb n] [--max-wall-ms n]
 *       [--broker-pipe nom --broker-port p] -- exe [args...]
 *     Pose les ACE (Modify sur --rw, ReadAndExecute sur --ro), crée le Job Object nommé
 *     (KILL_ON_JOB_CLOSE, sans breakaway, limites de processus et de mémoire), lance `exe`
 *     suspendu dans l'AppContainer sans capacité (SECURITY_CAPABILITIES), assigné au job
 *     dès sa création (JOB_LIST), avec un environnement limité aux --env et trois poignées
 *     héritées (HANDLE_LIST : stdin alimenté par ce lanceur, stdout du lanceur, stderr NUL).
 *     Commandes sur stdin : `in <texte>`, `eof` (ferme l'entrée de l'enfant), `kill` ; fin de stdin = kill. Fin du processus
 *     principal = fin de ses descendants. Retire les ACE en sortie. Événements JSON sur
 *     stderr, préfixés par `mindwake-sandbox `.
 *   query | terminate --job-name N [--timeout-ms n]
 *     Comme le lanceur du runner : état ou terminaison du job par son nom.
 *   probe op:arg... | spin [--child]
 *     Sonde exécutée DANS le conteneur par l'autotest : appelle l'API Windows et rapporte
 *     le code d'erreur système de chaque tentative (jamais le contenu lu).
 */
export const SANDBOX_LAUNCHER_SOURCE = String.raw`// MIND Wake — lanceur confiné AppContainer + Job Object (généré depuis src/sandbox/launcher-source.ts).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

static class Native
{
    public const uint CREATE_SUSPENDED = 0x4;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const int STARTF_USESTDHANDLES = 0x100;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x00020009;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000D;
    public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
    public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT = 3;
    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4;
    public const uint JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
    public const uint JOB_OBJECT_QUERY = 0x0004;
    public const uint JOB_OBJECT_TERMINATE = 0x0008;
    public const int ERROR_ALREADY_EXISTS = 183;
    public const uint HANDLE_FLAG_INHERIT = 1;
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_WRITE_ATTRIBUTES = 0x100;
    public const uint OPEN_EXISTING = 3;
    public const uint CREATE_ALWAYS = 2;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    public const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    public const uint PIPE_ACCESS_DUPLEX = 3;
    public const uint PIPE_REJECT_REMOTE_CLIENTS = 8;
    public const uint FSCTL_SET_REPARSE_POINT = 0x000900A4;

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
    public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
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

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr p);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr s);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, IntPtr size);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr p);

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
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateHardLink(string link, string target, IntPtr sa);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateDirectory(string path, IntPtr sa);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindFirstFile(string pattern, IntPtr data);
    [DllImport("kernel32.dll")]
    public static extern bool FindClose(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadFile(IntPtr h, byte[] buf, int len, out int read, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(IntPtr h, byte[] buf, int len, out int written, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, int inLen, IntPtr outBuf, int outLen, out int ret, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, ref SECURITY_ATTRIBUTES sa);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DuplicateHandle(IntPtr sp, IntPtr h, IntPtr tp, out IntPtr dup, uint access, bool inherit, uint opts);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr p, uint code);
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
    static readonly IntPtr Invalid = new IntPtr(-1);

    static int Main(string[] args)
    {
        Events = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
        Events.AutoFlush = true;
        try
        {
            if (args.Length == 0) throw new ArgumentException("mode manquant");
            switch (args[0])
            {
                case "probe": return Probe.Run(args);
                case "spin": return Probe.Spin(args);
            }
            var o = new Options(args);
            switch (args[0])
            {
                case "run": return Run(o);
                case "query": return Query(o.Require(o.JobName, "--job-name"));
                case "terminate": return TerminateNamed(o.Require(o.JobName, "--job-name"), o.TimeoutMs);
                case "profile-create": return ProfileCreate(o.Require(o.Profile, "--profile"));
                case "profile-delete": return ProfileDelete(o.Require(o.Profile, "--profile"));
                case "profile-status": return ProfileStatus(o.Require(o.Profile, "--profile"));
                case "revoke": return Revoke(o.Require(o.Profile, "--profile"), o.ReadWrite, o.ReadOnly);
                case "acl-status": return AclStatus(o.Require(o.Profile, "--profile"), o.ReadWrite, o.ReadOnly);
                default: throw new ArgumentException("mode inconnu: " + args[0]);
            }
        }
        catch (Exception e)
        {
            Emit("{\"event\":\"error\",\"message\":" + Json(e.Message) + "}");
            return 3;
        }
    }

    sealed class Options
    {
        public string JobName, Profile, Cwd, BrokerPipe; public int MaxProcs, JobMemMb, MaxWallMs, BrokerPort;
        public int TimeoutMs = 1000; public readonly List<string> Command = new List<string>();
        public readonly List<string> ReadWrite = new List<string>(), ReadOnly = new List<string>();
        public readonly SortedDictionary<string, string> Env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Options(string[] args)
        {
            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--") { for (int k = i + 1; k < args.Length; k++) Command.Add(args[k]); break; }
                else if (a == "--job-name") JobName = args[++i];
                else if (a == "--profile") Profile = args[++i];
                else if (a == "--cwd") Cwd = Path.GetFullPath(args[++i]);
                else if (a == "--rw") ReadWrite.Add(Path.GetFullPath(args[++i]));
                else if (a == "--ro") ReadOnly.Add(Path.GetFullPath(args[++i]));
                else if (a == "--max-procs") MaxProcs = int.Parse(args[++i]);
                else if (a == "--job-mem-mb") JobMemMb = int.Parse(args[++i]);
                else if (a == "--max-wall-ms") MaxWallMs = int.Parse(args[++i]);
                else if (a == "--timeout-ms") TimeoutMs = int.Parse(args[++i]);
                else if (a == "--broker-pipe") BrokerPipe = args[++i];
                else if (a == "--broker-port") BrokerPort = int.Parse(args[++i]);
                else if (a == "--env") { string kv = args[++i]; int eq = kv.IndexOf('='); if (eq <= 0) throw new ArgumentException("--env K=V"); Env[kv.Substring(0, eq)] = kv.Substring(eq + 1); }
                else throw new ArgumentException("option inconnue: " + a);
            }
        }
        public string Require(string v, string name) { if (string.IsNullOrEmpty(v)) throw new ArgumentException(name + " requis"); return v; }
    }

    // ---------- profil AppContainer ----------

    static string DeriveSid(string name)
    {
        IntPtr sid;
        int hr = Native.DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0) throw new Exception("DeriveAppContainerSidFromAppContainerName hr=0x" + hr.ToString("x8"));
        try { return SidToString(sid); } finally { Native.FreeSid(sid); }
    }

    static string SidToString(IntPtr sid)
    {
        IntPtr p;
        if (!Native.ConvertSidToStringSid(sid, out p)) throw new Exception("ConvertSidToStringSid " + Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(p); } finally { Native.LocalFree(p); }
    }

    const string MappingsKey = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\";

    static bool ProfileExists(string sid)
    {
        using (var k = Registry.CurrentUser.OpenSubKey(MappingsKey + sid)) return k != null;
    }

    static int ProfileCreate(string name)
    {
        IntPtr sid;
        int hr = Native.CreateAppContainerProfile(name, name, "MIND Wake sandbox", IntPtr.Zero, 0, out sid);
        bool created = hr == 0;
        if (created) Native.FreeSid(sid);
        else if (hr != unchecked((int)0x800700B7)) throw new Exception("CreateAppContainerProfile hr=0x" + hr.ToString("x8"));
        Console.Out.WriteLine("{\"profile\":" + Json(name) + ",\"sid\":" + Json(DeriveSid(name)) + ",\"created\":" + B(created) + "}");
        return 0;
    }

    static int ProfileDelete(string name)
    {
        int hr = Native.DeleteAppContainerProfile(name);
        Console.Out.WriteLine("{\"profile\":" + Json(name) + ",\"hresult\":" + hr + "}");
        return hr == 0 ? 0 : 1;
    }

    static int ProfileStatus(string name)
    {
        string sid = DeriveSid(name);
        bool mapped = ProfileExists(sid);
        string packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Packages", name);
        bool folder = Directory.Exists(packages);
        Console.Out.WriteLine("{\"profile\":" + Json(name) + ",\"sid\":" + Json(sid) + ",\"exists\":" + B(mapped || folder) +
            ",\"registryMapping\":" + B(mapped) + ",\"folder\":" + B(folder) + "}");
        return 0;
    }

    // ---------- ACE des racines ----------

    static void Grant(string dir, SecurityIdentifier sid, FileSystemRights rights)
    {
        var ds = Directory.GetAccessControl(dir, AccessControlSections.Access);
        ds.AddAccessRule(new FileSystemAccessRule(sid, rights | FileSystemRights.Synchronize,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(dir, ds);
    }

    // Retire toutes les ACE explicites du SID ; la propagation retire les ACE héritées.
    static bool Purge(string dir, SecurityIdentifier sid)
    {
        if (!Directory.Exists(dir)) return false;
        var ds = Directory.GetAccessControl(dir, AccessControlSections.Access);
        if (!HasRule(ds, sid)) return false;
        ds.PurgeAccessRules(sid);
        Directory.SetAccessControl(dir, ds);
        return true;
    }

    static bool HasRule(DirectorySecurity ds, SecurityIdentifier sid)
    {
        foreach (FileSystemAccessRule r in ds.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (r.IdentityReference.Equals(sid)) return true;
        return false;
    }

    static int Revoke(string name, List<string> rw, List<string> ro)
    {
        var sid = new SecurityIdentifier(DeriveSid(name));
        var parts = new List<string>();
        foreach (var d in Concat(rw, ro)) parts.Add("{\"path\":" + Json(d) + ",\"removed\":" + B(Purge(d, sid)) + "}");
        Console.Out.WriteLine("{\"revoked\":[" + string.Join(",", parts.ToArray()) + "]}");
        return 0;
    }

    static int AclStatus(string name, List<string> rw, List<string> ro)
    {
        var sid = new SecurityIdentifier(DeriveSid(name));
        var parts = new List<string>();
        foreach (var d in Concat(rw, ro))
        {
            bool exists = Directory.Exists(d);
            bool has = exists && HasRule(Directory.GetAccessControl(d, AccessControlSections.Access), sid);
            parts.Add("{\"path\":" + Json(d) + ",\"exists\":" + B(exists) + ",\"granted\":" + B(has) + "}");
        }
        Console.Out.WriteLine("{\"acl\":[" + string.Join(",", parts.ToArray()) + "]}");
        return 0;
    }

    static List<string> Concat(List<string> a, List<string> b) { var l = new List<string>(a); l.AddRange(b); return l; }

    // ---------- lancement confiné ----------

    static int Run(Options o)
    {
        string jobName = o.Require(o.JobName, "--job-name");
        string profile = o.Require(o.Profile, "--profile");
        if (o.Command.Count == 0) throw new ArgumentException("commande manquante après --");
        var cmd = new StringBuilder();
        foreach (var a in o.Command) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(QuoteArg(a)); }
        if ((o.BrokerPipe == null) != (o.BrokerPort == 0)) throw new ArgumentException("--broker-pipe et --broker-port vont ensemble");

        string sidStr = DeriveSid(profile);
        if (!ProfileExists(sidStr)) throw new Exception("profil AppContainer absent: " + profile);
        var sid = new SecurityIdentifier(sidStr);
        var granted = new List<string>();
        try
        {
            foreach (var d in o.ReadWrite) { Grant(d, sid, FileSystemRights.Modify); granted.Add(d); }
            foreach (var d in o.ReadOnly) { Grant(d, sid, FileSystemRights.ReadAndExecute); granted.Add(d); }
            Emit("{\"event\":\"identity\",\"profile\":" + Json(profile) + ",\"sid\":" + Json(sidStr) + ",\"capabilities\":[],\"grants\":" + granted.Count + "}");
            Broker broker = o.BrokerPipe == null ? null : new Broker(o.BrokerPipe, o.BrokerPort, sidStr);
            try { return Launch(o, jobName, sidStr, cmd); }
            finally { if (broker != null) broker.Stop(); }
        }
        finally
        {
            foreach (var d in granted) { try { Purge(d, sid); } catch (Exception) { } }
            Emit("{\"event\":\"revoked\",\"count\":" + granted.Count + "}");
        }
    }

    static int Launch(Options o, string jobName, string sidStr, StringBuilder cmd)
    {
        Job = Native.CreateJobObject(IntPtr.Zero, jobName);
        if (Job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
        if (Marshal.GetLastWin32Error() == Native.ERROR_ALREADY_EXISTS) throw new Exception("job deja existant: " + jobName);
        IntPtr port = Native.CreateIoCompletionPort(Invalid, IntPtr.Zero, UIntPtr.Zero, 1);
        SetJobInfo(7, new Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey = (IntPtr)1, CompletionPort = port });
        var lim = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        lim.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if (o.MaxProcs > 0) { lim.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS; lim.BasicLimitInformation.ActiveProcessLimit = (uint)o.MaxProcs; }
        if (o.JobMemMb > 0) { lim.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_JOB_MEMORY; lim.JobMemoryLimit = (UIntPtr)((ulong)o.JobMemMb * 1024 * 1024); }
        SetJobInfo(9, lim);

        var sa = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr inRead, inWrite;
        if (!Native.CreatePipe(out inRead, out inWrite, ref sa, 0)) throw new Exception("CreatePipe " + Marshal.GetLastWin32Error());
        Native.SetHandleInformation(inWrite, Native.HANDLE_FLAG_INHERIT, 0);
        IntPtr nul = Native.CreateFile("NUL", Native.GENERIC_WRITE, 3, ref sa, Native.OPEN_EXISTING, 0, IntPtr.Zero);
        IntPtr outDup;
        Native.DuplicateHandle(Native.GetCurrentProcess(), Native.GetStdHandle(-11), Native.GetCurrentProcess(), out outDup, 0, true, 2);

        var allocs = new List<IntPtr>();
        IntPtr size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref size);
        IntPtr attrs = Marshal.AllocHGlobal(size); allocs.Add(attrs);
        if (!Native.InitializeProcThreadAttributeList(attrs, 3, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());

        // Identité : SID du conteneur, aucune capacité (ni réseau, ni registre, ni bibliothèques).
        IntPtr acSid;
        int hr = Native.DeriveAppContainerSidFromAppContainerName(o.Profile, out acSid);
        if (hr != 0) throw new Exception("DeriveAppContainerSidFromAppContainerName hr=0x" + hr.ToString("x8"));
        var sc = new Native.SECURITY_CAPABILITIES { AppContainerSid = acSid, Capabilities = IntPtr.Zero, CapabilityCount = 0 };
        IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc)); allocs.Add(scPtr); Marshal.StructureToPtr(sc, scPtr, false);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, scPtr, Marshal.SizeOf(sc));
        IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size); allocs.Add(jobList); Marshal.WriteIntPtr(jobList, Job);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList, IntPtr.Size);
        IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3); allocs.Add(handles);
        Marshal.WriteIntPtr(handles, inRead); Marshal.WriteIntPtr(handles + IntPtr.Size, outDup); Marshal.WriteIntPtr(handles + 2 * IntPtr.Size, nul);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, IntPtr.Size * 3);

        // Environnement explicite : seules les variables passées par --env, rien n'est hérité.
        var envSb = new StringBuilder();
        foreach (var kv in o.Env) envSb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        envSb.Append('\0');
        IntPtr envPtr = Marshal.StringToHGlobalUni(envSb.ToString()); allocs.Add(envPtr);

        var si = new Native.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = inRead; si.StartupInfo.hStdOutput = outDup; si.StartupInfo.hStdError = nul;
        si.lpAttributeList = attrs;
        uint flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_NO_WINDOW;
        Native.PROCESS_INFORMATION pi;
        if (!Native.CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, o.Cwd, ref si, out pi))
            throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
        Native.CloseHandle(inRead); Native.CloseHandle(outDup); Native.CloseHandle(nul);
        Native.FreeSid(acSid);
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

        var wall = Stopwatch.StartNew();
        uint mainExit = 259;
        while (true)
        {
            uint msg; UIntPtr key; IntPtr ov;
            bool got = Native.GetQueuedCompletionStatus(port, out msg, out key, out ov, 10);
            if (got && msg == Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) break;
            if (got && msg == Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT) Emit("{\"event\":\"limit\",\"kind\":\"processes\"}");
            if (got && msg == Native.JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) Emit("{\"event\":\"limit\",\"kind\":\"memory\"}");
            if (o.MaxWallMs > 0 && wall.ElapsedMilliseconds >= o.MaxWallMs) Kill("max-wall");
            if (Native.WaitForSingleObject(pi.hProcess, 0) == 0) Kill("main-exited");
            if (QueryAccounting(Job).ActiveProcesses == 0) break;
        }
        double killMs = -1;
        lock (Gate) { if (KillRequested) { KillWatch.Stop(); killMs = KillWatch.Elapsed.TotalMilliseconds; } }
        Native.GetExitCodeProcess(pi.hProcess, out mainExit);
        var acct = QueryAccounting(Job);
        Emit("{\"event\":\"done\",\"mainExitCode\":" + mainExit + ",\"killReason\":" + Json(KillReason) +
             ",\"killToZeroMs\":" + Num(killMs) + ",\"totalProcesses\":" + acct.TotalProcesses +
             ",\"activeProcesses\":" + acct.ActiveProcesses + "}");
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
        Emit("{\"event\":\"kill-issued\",\"reason\":" + Json(reason) + ",\"ok\":" + B(ok) + "}");
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
        Console.Out.WriteLine("{\"found\":true,\"terminated\":" + B(ok) + ",\"active\":" + active + ",\"ms\":" + Num(watch.Elapsed.TotalMilliseconds) + "}");
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

    public static void Emit(string json) { lock (Events) Events.WriteLine("mindwake-sandbox " + json); }

    public static string B(bool b) { return b ? "true" : "false"; }
    public static string Num(double d) { return d.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture); }

    public static string Json(string s)
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
    public static string QuoteArg(string a)
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

// Point d'extension du broker fournisseur (ADR-002, ADR-004) : un pipe nommé, hors du
// conteneur, que seuls l'utilisateur et le SID de ce conteneur peuvent ouvrir (étiquette
// d'intégrité basse pour l'AppContainer). Chaque connexion est relayée octet pour octet
// vers 127.0.0.1:<port>, où le daemon applique allowlist, budget et credential. Le
// conteneur n'a aucune autre route réseau.
sealed class Broker
{
    readonly string name; readonly int port; readonly string sddl; volatile bool stopped;
    readonly Thread acceptor;

    public Broker(string pipeName, int upstreamPort, string acSid)
    {
        name = @"\\.\pipe\" + pipeName; port = upstreamPort;
        string user = WindowsIdentity.GetCurrent().User.Value;
        sddl = "D:P(A;;GA;;;" + user + ")(A;;GRGW;;;" + acSid + ")S:(ML;;NW;;;LW)";
        IntPtr first = Create(true);
        acceptor = new Thread(() => Accept(first)); acceptor.IsBackground = true; acceptor.Start();
        Launcher.Emit("{\"event\":\"broker-listening\",\"pipe\":" + Launcher.Json(pipeName) + "}");
    }

    IntPtr Create(bool first)
    {
        IntPtr sd;
        if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, IntPtr.Zero)) throw new Exception("SDDL " + Marshal.GetLastWin32Error());
        try
        {
            var sa = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)), lpSecurityDescriptor = sd, bInheritHandle = false };
            uint open = Native.PIPE_ACCESS_DUPLEX | Native.FILE_FLAG_OVERLAPPED | (first ? 0x00080000u /* FILE_FLAG_FIRST_PIPE_INSTANCE */ : 0u);
            IntPtr h = Native.CreateNamedPipe(name, open, Native.PIPE_REJECT_REMOTE_CLIENTS, 255, 65536, 65536, 0, ref sa);
            if (h == new IntPtr(-1)) throw new Exception("CreateNamedPipe " + Marshal.GetLastWin32Error());
            return h;
        }
        finally { Native.LocalFree(sd); }
    }

    void Accept(IntPtr handle)
    {
        while (!stopped)
        {
            NamedPipeServerStream server;
            try
            {
                server = new NamedPipeServerStream(PipeDirection.InOut, true, false, new SafePipeHandle(handle, true));
                server.WaitForConnection();
            }
            catch (Exception) { return; }
            if (stopped) { server.Dispose(); return; }
            try { handle = Create(false); } catch (Exception) { handle = IntPtr.Zero; }
            var s = server;
            var t = new Thread(() => Relay(s)); t.IsBackground = true; t.Start();
            if (handle == IntPtr.Zero) return;
        }
    }

    void Relay(NamedPipeServerStream pipe)
    {
        Launcher.Emit("{\"event\":\"broker-connection\"}");
        try
        {
            using (pipe)
            using (var tcp = new TcpClient())
            {
                tcp.Connect(IPAddress.Loopback, port);
                var net = tcp.GetStream();
                var up = new Thread(() => Copy(pipe, net, tcp)); up.IsBackground = true; up.Start();
                Copy(net, pipe, null);
                up.Join(2000);
            }
        }
        catch (Exception) { }
    }

    static void Copy(Stream from, Stream to, TcpClient halfClose)
    {
        var buf = new byte[16384];
        try
        {
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); }
        }
        catch (Exception) { }
        if (halfClose != null) { try { halfClose.Client.Shutdown(SocketShutdown.Send); } catch (Exception) { } }
    }

    public void Stop()
    {
        stopped = true;
        // Débloque WaitForConnection : une connexion locale fictive.
        try { using (var c = new NamedPipeClientStream(".", name.Substring(9), PipeDirection.InOut)) c.Connect(200); } catch (Exception) { }
    }
}

// Sonde exécutée DANS le conteneur par les tests de refus et l'autotest de "doctor" : chaque
// tentative appelle directement l'API Windows et rapporte le code d'erreur du système.
// Aucune donnée lue n'est rapportée, seulement des tailles et des codes.
static class Probe
{
    public static int Run(string[] args)
    {
        for (int i = 1; i < args.Length; i++)
        {
            string a = args[i]; int c = a.IndexOf(':');
            string op = c < 0 ? a : a.Substring(0, c); string arg = c < 0 ? "" : a.Substring(c + 1);
            string result;
            try { result = Run(op, arg); }
            catch (Exception e) { result = "\"ok\":false,\"code\":-1,\"detail\":" + Launcher.Json(e.GetType().Name + ": " + e.Message); }
            Console.Out.WriteLine("probe {\"op\":" + Launcher.Json(op) + ",\"arg\":" + Launcher.Json(arg) + "," + result + "}");
            Console.Out.Flush();
        }
        return 0;
    }

    static string Ok(bool ok, int code) { return "\"ok\":" + Launcher.B(ok) + ",\"code\":" + code; }
    static string Last(bool ok) { return Ok(ok, ok ? 0 : Marshal.GetLastWin32Error()); }

    static string Run(string op, string arg)
    {
        switch (op)
        {
            case "write": return WriteFile(arg);
            case "read": return ReadFile(arg);
            case "list":
            {
                IntPtr data = Marshal.AllocHGlobal(1024);
                try { IntPtr h = Native.FindFirstFile(Path.Combine(arg, "*"), data); bool ok = h != new IntPtr(-1); int code = ok ? 0 : Marshal.GetLastWin32Error(); if (ok) Native.FindClose(h); return Ok(ok, code); }
                finally { Marshal.FreeHGlobal(data); }
            }
            case "hardlink": { string[] p = arg.Split('|'); return Last(Native.CreateHardLink(p[0], p[1], IntPtr.Zero)); }
            case "junction": { string[] p = arg.Split('|'); return Junction(p[0], p[1]); }
            case "tcp": return Tcp(arg);
            case "dns":
                try { Dns.GetHostAddresses(arg); return Ok(true, 0); }
                catch (SocketException e) { return Ok(false, e.ErrorCode); }
            case "pipe": return Pipe(arg);
            case "env": return "\"ok\":" + Launcher.B(Environment.GetEnvironmentVariable(arg) != null) + ",\"code\":0";
            case "envcount": return "\"ok\":true,\"code\":0,\"count\":" + Environment.GetEnvironmentVariables().Count;
            case "openproc":
            {
                IntPtr h = Native.OpenProcess(0x0010 | 0x0400, false, int.Parse(arg));
                bool ok = h != IntPtr.Zero; int code = ok ? 0 : Marshal.GetLastWin32Error(); if (ok) Native.CloseHandle(h); return Ok(ok, code);
            }
            case "regwrite":
                try
                {
                    using (var k = Registry.CurrentUser.CreateSubKey(arg)) { }
                    // Ne jamais laisser de trace persistante : suppression immédiate si l'écriture passe.
                    Registry.CurrentUser.DeleteSubKey(arg, false);
                    return Ok(true, 0);
                }
                catch (UnauthorizedAccessException) { return Ok(false, 5); }
            case "breakaway": return Spawn(true, "");
            case "spawn": return Spawn(false, arg);
            case "spawn-many":
            {
                int n = int.Parse(arg), ok = 0, refused = 0, last = 0;
                for (int k = 0; k < n; k++)
                {
                    int code; int pid = SpawnSpin(false, out code, "");
                    if (pid > 0) ok++; else { refused++; last = code; }
                }
                return "\"ok\":" + Launcher.B(refused == 0) + ",\"code\":" + last + ",\"started\":" + ok + ",\"refused\":" + refused;
            }
            case "alloc":
            {
                int mb = int.Parse(arg), got = 0;
                var keep = new List<IntPtr>();
                try { for (; got < mb; got += 16) { IntPtr p = Marshal.AllocHGlobal(16 * 1024 * 1024); keep.Add(p); for (int o = 0; o < 16 * 1024 * 1024; o += 4096) Marshal.WriteByte(p, o, 1); } }
                catch (OutOfMemoryException) { foreach (var p in keep) Marshal.FreeHGlobal(p); return "\"ok\":false,\"code\":8,\"allocatedMb\":" + got; }
                foreach (var p in keep) Marshal.FreeHGlobal(p);
                return "\"ok\":true,\"code\":0,\"allocatedMb\":" + got;
            }
            case "sleep": Thread.Sleep(int.Parse(arg)); return Ok(true, 0);
            default: return "\"ok\":false,\"code\":-2,\"detail\":\"op inconnue\"";
        }
    }

    static string WriteFile(string path)
    {
        IntPtr h = Native.CreateFile(path, Native.GENERIC_WRITE, 0, IntPtr.Zero, Native.CREATE_ALWAYS, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return Last(false);
        byte[] b = Encoding.ASCII.GetBytes("mindwake-probe\n"); int w;
        bool ok = Native.WriteFile(h, b, b.Length, out w, IntPtr.Zero); int code = ok ? 0 : Marshal.GetLastWin32Error();
        Native.CloseHandle(h);
        return Ok(ok, code);
    }

    static string ReadFile(string path)
    {
        IntPtr h = Native.CreateFile(path, Native.GENERIC_READ, 1, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return Last(false);
        var buf = new byte[4096]; int r;
        bool ok = Native.ReadFile(h, buf, buf.Length, out r, IntPtr.Zero); int code = ok ? 0 : Marshal.GetLastWin32Error();
        Native.CloseHandle(h);
        return Ok(ok, code) + ",\"bytes\":" + (ok ? r : 0);
    }

    // Création d'une jonction (point de montage) "link" → "target" par FSCTL_SET_REPARSE_POINT.
    static string Junction(string link, string target)
    {
        if (!Native.CreateDirectory(link, IntPtr.Zero)) return Last(false) + ",\"stage\":\"mkdir\"";
        IntPtr h = Native.CreateFile(link, Native.GENERIC_WRITE, 0, IntPtr.Zero, Native.OPEN_EXISTING,
            Native.FILE_FLAG_BACKUP_SEMANTICS | Native.FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (h == new IntPtr(-1)) return Last(false) + ",\"stage\":\"open\"";
        byte[] sub = Encoding.Unicode.GetBytes(@"\??\" + target); byte[] print = Encoding.Unicode.GetBytes(target);
        int pathLen = sub.Length + 2 + print.Length + 2;
        var buf = new byte[8 + 8 + pathLen];
        BitConverter.GetBytes(0xA0000003u).CopyTo(buf, 0);
        BitConverter.GetBytes((ushort)(8 + pathLen)).CopyTo(buf, 4);
        BitConverter.GetBytes((ushort)0).CopyTo(buf, 8);
        BitConverter.GetBytes((ushort)sub.Length).CopyTo(buf, 10);
        BitConverter.GetBytes((ushort)(sub.Length + 2)).CopyTo(buf, 12);
        BitConverter.GetBytes((ushort)print.Length).CopyTo(buf, 14);
        sub.CopyTo(buf, 16); print.CopyTo(buf, 16 + sub.Length + 2);
        int ret;
        bool ok = Native.DeviceIoControl(h, Native.FSCTL_SET_REPARSE_POINT, buf, buf.Length, IntPtr.Zero, 0, out ret, IntPtr.Zero);
        int code = ok ? 0 : Marshal.GetLastWin32Error();
        Native.CloseHandle(h);
        return Ok(ok, code) + ",\"stage\":\"reparse\"";
    }

    static string Tcp(string hostPort)
    {
        int c = hostPort.LastIndexOf(':');
        var addr = IPAddress.Parse(hostPort.Substring(0, c)); int port = int.Parse(hostPort.Substring(c + 1));
        using (var s = new Socket(addr.AddressFamily, SocketType.Stream, ProtocolType.Tcp))
        {
            try
            {
                var ar = s.BeginConnect(addr, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(2000)) return "\"ok\":false,\"code\":10060,\"detail\":\"timeout\"";
                s.EndConnect(ar);
                return Ok(true, 0);
            }
            catch (SocketException e) { return Ok(false, e.ErrorCode); }
        }
    }

    // Connexion à un pipe nommé : écrit "ping\n" et attend une réponse (le broker d'essai fait écho).
    static string Pipe(string name)
    {
        IntPtr h = Native.CreateFile(@"\\.\pipe\" + name, Native.GENERIC_READ | Native.GENERIC_WRITE, 0, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return Last(false);
        try
        {
            byte[] b = Encoding.ASCII.GetBytes("ping\n"); int n;
            if (!Native.WriteFile(h, b, b.Length, out n, IntPtr.Zero)) return Last(false) + ",\"stage\":\"write\"";
            var buf = new byte[64];
            if (!Native.ReadFile(h, buf, buf.Length, out n, IntPtr.Zero)) return Last(false) + ",\"stage\":\"read\"";
            return Ok(true, 0) + ",\"reply\":" + Launcher.Json(Encoding.ASCII.GetString(buf, 0, n).Trim());
        }
        finally { Native.CloseHandle(h); }
    }

    static string Self() { return System.Reflection.Assembly.GetExecutingAssembly().Location; }

    static string Spawn(bool breakaway, string probeArg)
    {
        int code; int pid = SpawnSpin(breakaway, out code, probeArg);
        return Ok(pid > 0, code) + ",\"pid\":" + pid;
    }

    // Lance une copie de ce binaire : "spin" (boucle) ou "spin --child" (lance aussi un petit-enfant).
    public static int SpawnSpin(bool breakaway, out int code, string extra)
    {
        var cmd = new StringBuilder(Launcher.QuoteArg(Self()) + " spin" + (extra == "tree" ? " --child" : ""));
        var si = new Native.STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
        // La sortie standard héritée permet au petit-enfant de rapporter son PID.
        si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        si.StartupInfo.hStdOutput = Native.GetStdHandle(-11);
        Native.PROCESS_INFORMATION pi;
        uint flags = Native.CREATE_NO_WINDOW | (breakaway ? Native.CREATE_BREAKAWAY_FROM_JOB : 0);
        if (!Native.CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi))
        {
            code = Marshal.GetLastWin32Error(); return 0;
        }
        code = 0;
        // Une sortie du job ne doit jamais survivre à la sonde : la copie évadée est terminée aussitôt.
        if (breakaway) Native.TerminateProcess(pi.hProcess, 1);
        Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }

    // Processus non coopératif : boucle sans fin ; avec --child, lance d'abord un petit-enfant
    // et rapporte son PID sur la sortie standard héritée.
    public static int Spin(string[] args)
    {
        if (args.Length > 1 && args[1] == "--child")
        {
            int code; int pid = SpawnSpin(false, out code, "");
            Console.Out.WriteLine("probe {\"op\":\"grandchild\",\"ok\":" + Launcher.B(pid > 0) + ",\"code\":" + code + ",\"pid\":" + pid + "}");
            Console.Out.Flush();
        }
        while (true) Thread.Sleep(50);
    }
}
`;
