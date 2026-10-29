// Spike S2 — lanceur confiné Windows : AppContainer (ou LPAC) + Job Object.
// Compilé avec le csc.exe de .NET Framework 4.x livré avec Windows (C# 5, aucune dépendance).
//
// Modes :
//   run   [options] -- <exe> [args...]   lance <exe> dans un AppContainer, assigné à un Job Object dès la création
//   lowil [options] -- <exe> [args...]   même chose avec un simple jeton à intégrité basse (comparaison)
//   plain [options] -- <exe> [args...]   même chose sans confinement (témoin), mais dans le Job Object
//   probe-proc <pid>                     tente d'ouvrir un processus (lecture mémoire, terminaison)
//   cleanup --name <n>                   supprime le profil AppContainer s'il existe
//
// Options : --name n  --lpac  --cap internetClient|privateNetworkClientServer|S-1-15-3-...
//           --cap name:<capacité nommée, ex. registryRead>
//           --rw dir  --ro dir  --env K=V  --cwd dir  --max-procs n  --job-mem-mb n  --timeout-ms n
//
// Événements JSON (une ligne chacun) sur stderr, préfixés par "@@SANDBOX ". La sortie standard et
// l'erreur standard du processus confiné sont redirigées vers la sortie standard de ce lanceur.
// Commandes sur stdin : "kill" termine le job ; la fin de stdin (contrôleur disparu) termine aussi le job.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Native
{
    public const uint CREATE_SUSPENDED = 0x4;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const int STARTF_USESTDHANDLES = 0x100;

    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x00020009;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000D;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY = (IntPtr)0x0002000F;

    public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
    public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT = 3;
    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4;
    public const uint JOB_OBJECT_MSG_NEW_PROCESS = 6;
    public const uint JOB_OBJECT_MSG_EXIT_PROCESS = 7;
    public const uint JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS = 8;
    public const uint JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;

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
    public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved;
    }

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

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(string name);

    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupCount, out IntPtr capSids, out uint capCount);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr s);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern int GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr sa, int impLevel, int type, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetTokenInformation(IntPtr token, int cls, IntPtr info, int len);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll")]
    public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr sa, string name);
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
    public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DuplicateHandle(IntPtr sp, IntPtr h, IntPtr tp, out IntPtr dup, uint access, bool inherit, uint opts);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
}

static class Program
{
    static readonly object Gate = new object();
    static IntPtr Job;
    static bool KillRequested;
    static string KillReason;
    static readonly Stopwatch KillWatch = new Stopwatch();

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) { Console.Error.WriteLine("usage: sandbox run|lowil|plain|probe-proc|cleanup ..."); return 2; }
            switch (args[0])
            {
                case "run": case "lowil": case "plain": return Run(args[0], args);
                case "probe-proc": return ProbeProc(int.Parse(args[1]));
                case "cleanup": return Cleanup(args);
                default: Console.Error.WriteLine("mode inconnu: " + args[0]); return 2;
            }
        }
        catch (Exception e)
        {
            Emit("{\"event\":\"error\",\"message\":" + Json(e.Message) + "}");
            return 3;
        }
    }

    // ---------- sortie ----------

    static void Emit(string json) { lock (Gate) { Console.Error.WriteLine("@@SANDBOX " + json); Console.Error.Flush(); } }

    static string Json(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string SidToString(IntPtr sid)
    {
        IntPtr p; if (!Native.ConvertSidToStringSid(sid, out p)) return null;
        return Marshal.PtrToStringUni(p);
    }

    // ---------- modes simples ----------

    static int ProbeProc(int pid)
    {
        // Lecture de la mémoire (PEB, variables d'environnement) et terminaison du processus cible.
        var checks = new[] {
            new KeyValuePair<string, uint>("vmread", 0x0010 | 0x0400),
            new KeyValuePair<string, uint>("terminate", 0x0001),
            new KeyValuePair<string, uint>("query_limited", 0x1000),
        };
        var parts = new List<string>();
        foreach (var c in checks)
        {
            IntPtr h = Native.OpenProcess(c.Value, false, pid);
            int err = Marshal.GetLastWin32Error();
            parts.Add("\"" + c.Key + "\":{\"opened\":" + (h != IntPtr.Zero ? "true" : "false") + ",\"error\":" + (h != IntPtr.Zero ? 0 : err) + "}");
            if (h != IntPtr.Zero) Native.CloseHandle(h); // ouverture seulement : aucune lecture ni terminaison effectuée
        }
        Console.Out.WriteLine("{\"pid\":" + pid + "," + string.Join(",", parts) + "}");
        return 0;
    }

    static int Cleanup(string[] args)
    {
        string name = null;
        for (int i = 1; i < args.Length - 1; i++) if (args[i] == "--name") name = args[i + 1];
        if (name == null) return 2;
        int hr = Native.DeleteAppContainerProfile(name);
        Emit("{\"event\":\"cleanup\",\"name\":" + Json(name) + ",\"hresult\":" + hr + "}");
        return 0;
    }

    // ---------- lancement confiné ----------

    static int Run(string mode, string[] args)
    {
        string name = "mindwake.spike.s2", cwd = null;
        bool lpac = false, noProfile = false; int maxProcs = 0, jobMemMb = 0, timeoutMs = 0;
        var caps = new List<string>(); var rw = new List<string>(); var ro = new List<string>();
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        int i = 1;
        for (; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--") { i++; break; }
            else if (a == "--name") name = args[++i];
            else if (a == "--lpac") lpac = true;
            else if (a == "--no-profile") noProfile = true;
            else if (a == "--cap") caps.Add(args[++i]);
            else if (a == "--rw") rw.Add(Path.GetFullPath(args[++i]));
            else if (a == "--ro") ro.Add(Path.GetFullPath(args[++i]));
            else if (a == "--cwd") cwd = Path.GetFullPath(args[++i]);
            else if (a == "--max-procs") maxProcs = int.Parse(args[++i]);
            else if (a == "--job-mem-mb") jobMemMb = int.Parse(args[++i]);
            else if (a == "--timeout-ms") timeoutMs = int.Parse(args[++i]);
            else if (a == "--env") { string kv = args[++i]; int eq = kv.IndexOf('='); env[kv.Substring(0, eq)] = kv.Substring(eq + 1); }
            else throw new ArgumentException("option inconnue: " + a);
        }
        if (i >= args.Length) throw new ArgumentException("commande manquante après --");
        var cmd = new StringBuilder();
        for (int k = i; k < args.Length; k++) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(QuoteArg(args[k])); }

        // 1. Identité AppContainer : SID dérivé du nom ; profil créé seulement si nécessaire.
        IntPtr acSid = IntPtr.Zero; bool profileCreated = false; string acSidStr = null;
        var grants = new List<KeyValuePair<string, FileSystemRights>>();
        if (mode == "run")
        {
            int hr = noProfile ? -1 : Native.CreateAppContainerProfile(name, name, "MIND Wake spike S2 (temporaire)", IntPtr.Zero, 0, out acSid);
            if (hr == 0) profileCreated = true;
            else
            {
                // 0x800700B7 : le profil existe déjà (exécution précédente interrompue).
                hr = Native.DeriveAppContainerSidFromAppContainerName(name, out acSid);
                if (hr != 0) throw new Exception("DeriveAppContainerSidFromAppContainerName hr=0x" + hr.ToString("x8"));
            }
            acSidStr = SidToString(acSid);

            // 2. Racines : ACE explicites pour le SID du conteneur, rien d'autre n'est accordé.
            foreach (var d in rw) grants.Add(new KeyValuePair<string, FileSystemRights>(d, FileSystemRights.Modify | FileSystemRights.Synchronize));
            foreach (var d in ro) grants.Add(new KeyValuePair<string, FileSystemRights>(d, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize));
            foreach (var g in grants) SetGrant(g.Key, acSidStr, g.Value, true);
        }
        Emit("{\"event\":\"identity\",\"mode\":" + Json(mode) + ",\"name\":" + Json(name) + ",\"appContainerSid\":" + Json(acSidStr) +
             ",\"profileCreated\":" + (profileCreated ? "true" : "false") + ",\"lpac\":" + (lpac ? "true" : "false") +
             ",\"capabilities\":[" + string.Join(",", caps.ConvertAll(Json).ToArray()) + "]}");

        try
        {
            return Launch(mode, acSid, lpac, caps, env, cwd, cmd, maxProcs, jobMemMb, timeoutMs);
        }
        finally
        {
            foreach (var g in grants) { try { SetGrant(g.Key, acSidStr, g.Value, false); } catch { } }
            if (profileCreated) Native.DeleteAppContainerProfile(name);
        }
    }

    static void SetGrant(string dir, string sid, FileSystemRights rights, bool add)
    {
        var ds = Directory.GetAccessControl(dir);
        var rule = new FileSystemAccessRule(new SecurityIdentifier(sid), rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow);
        if (add) ds.AddAccessRule(rule); else ds.RemoveAccessRuleSpecific(rule);
        Directory.SetAccessControl(dir, ds);
    }

    static string CapabilitySid(string c)
    {
        if (c == "internetClient") return "S-1-15-3-1";
        if (c == "internetClientServer") return "S-1-15-3-2";
        if (c == "privateNetworkClientServer") return "S-1-15-3-3";
        return c;
    }

    static int Launch(string mode, IntPtr acSid, bool lpac, List<string> caps, SortedDictionary<string, string> env,
                      string cwd, StringBuilder cmd, int maxProcs, int jobMemMb, int timeoutMs)
    {
        // 3. Job Object : terminaison à la fermeture du handle, aucune sortie autorisée (pas de BREAKAWAY_OK).
        Job = Native.CreateJobObject(IntPtr.Zero, null);
        if (Job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
        IntPtr port = Native.CreateIoCompletionPort((IntPtr)(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        var acp = new Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey = (IntPtr)1, CompletionPort = port };
        SetJobInfo(7, acp);
        var lim = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        lim.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if (maxProcs > 0) { lim.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS; lim.BasicLimitInformation.ActiveProcessLimit = (uint)maxProcs; }
        if (jobMemMb > 0) { lim.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_JOB_MEMORY; lim.JobMemoryLimit = (UIntPtr)((ulong)jobMemMb * 1024 * 1024); }
        SetJobInfo(9, lim);

        // 4. Poignées standard : seules celles-ci sont héritées (liste explicite).
        var sa = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr nul = Native.CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
        IntPtr outDup;
        Native.DuplicateHandle(Native.GetCurrentProcess(), Native.GetStdHandle(-11), Native.GetCurrentProcess(), out outDup, 0, true, 2);

        // 5. Attributs de création.
        var allocs = new List<IntPtr>();
        Func<int, IntPtr> alloc = n => { IntPtr p = Marshal.AllocHGlobal(n); allocs.Add(p); return p; };
        int attrCount = 2 + (mode == "run" ? 1 : 0) + (lpac ? 1 : 0);
        IntPtr size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, attrCount, 0, ref size);
        IntPtr attrs = alloc((int)size);
        if (!Native.InitializeProcThreadAttributeList(attrs, attrCount, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());

        if (mode == "run")
        {
            var capArr = new List<Native.SID_AND_ATTRIBUTES>();
            foreach (var c in caps)
            {
                IntPtr cs;
                if (c.StartsWith("name:"))
                {
                    // Capacité nommée (ex. registryRead, lpacCom) : SID dérivé du nom par le système.
                    IntPtr g, sids; uint gn, sn;
                    if (!Native.DeriveCapabilitySidsFromName(c.Substring(5), out g, out gn, out sids, out sn) || sn == 0) throw new Exception("capability invalide: " + c);
                    cs = Marshal.ReadIntPtr(sids);
                }
                else if (!Native.ConvertStringSidToSid(CapabilitySid(c), out cs)) throw new Exception("capability invalide: " + c);
                capArr.Add(new Native.SID_AND_ATTRIBUTES { Sid = cs, Attributes = 4 /* SE_GROUP_ENABLED */ });
            }
            int saSize = Marshal.SizeOf(typeof(Native.SID_AND_ATTRIBUTES));
            IntPtr capsPtr = capArr.Count > 0 ? alloc(saSize * capArr.Count) : IntPtr.Zero;
            for (int k = 0; k < capArr.Count; k++) Marshal.StructureToPtr(capArr[k], capsPtr + k * saSize, false);
            var sc = new Native.SECURITY_CAPABILITIES { AppContainerSid = acSid, Capabilities = capsPtr, CapabilityCount = (uint)capArr.Count };
            IntPtr scPtr = alloc(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc, scPtr, false);
            Update(attrs, Native.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, scPtr, Marshal.SizeOf(sc));
            if (lpac)
            {
                IntPtr pol = alloc(4); Marshal.WriteInt32(pol, 1); // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
                Update(attrs, Native.PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, pol, 4);
            }
        }
        IntPtr jobList = alloc(IntPtr.Size); Marshal.WriteIntPtr(jobList, Job);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList, IntPtr.Size);
        IntPtr handles = alloc(IntPtr.Size * 2); Marshal.WriteIntPtr(handles, nul); Marshal.WriteIntPtr(handles + IntPtr.Size, outDup);
        Update(attrs, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, IntPtr.Size * 2);

        // 6. Environnement explicite : rien n'est hérité du parent.
        var envSb = new StringBuilder();
        foreach (var kv in env) envSb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        envSb.Append('\0');
        IntPtr envPtr = Marshal.StringToHGlobalUni(envSb.ToString()); allocs.Add(envPtr);

        var si = new Native.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = nul; si.StartupInfo.hStdOutput = outDup; si.StartupInfo.hStdError = outDup;
        si.lpAttributeList = attrs;
        uint flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_NO_WINDOW;

        Native.PROCESS_INFORMATION pi;
        bool ok;
        if (mode == "lowil")
        {
            IntPtr tok, dup;
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), 0x0002 | 0x0008 | 0x0080 | 0x0001, out tok)) throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error());
            if (!Native.DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());
            IntPtr low; Native.ConvertStringSidToSid("S-1-16-4096", out low);
            var tml = new Native.TOKEN_MANDATORY_LABEL { Label = new Native.SID_AND_ATTRIBUTES { Sid = low, Attributes = 0x20 /* SE_GROUP_INTEGRITY */ } };
            int tmlSize = Marshal.SizeOf(tml) + Native.GetLengthSid(low);
            IntPtr tmlPtr = alloc(tmlSize); Marshal.StructureToPtr(tml, tmlPtr, false);
            if (!Native.SetTokenInformation(dup, 25 /* TokenIntegrityLevel */, tmlPtr, tmlSize)) throw new Exception("SetTokenInformation " + Marshal.GetLastWin32Error());
            ok = Native.CreateProcessAsUser(dup, null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, cwd, ref si, out pi);
        }
        else
        {
            ok = Native.CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, cwd, ref si, out pi);
        }
        if (!ok) throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
        Native.CloseHandle(outDup); Native.CloseHandle(nul);
        Native.ResumeThread(pi.hThread);
        Emit("{\"event\":\"started\",\"pid\":" + pi.dwProcessId + ",\"launcherPid\":" + Process.GetCurrentProcess().Id + "}");

        // 7. Contrôle : stdin (kill / fin de flux) et délai maximal, indépendants du processus confiné.
        var ctl = new Thread(() =>
        {
            string line;
            while ((line = Console.In.ReadLine()) != null) if (line.Trim() == "kill") { Kill("command"); }
            Kill("controller-eof");
        });
        ctl.IsBackground = true; ctl.Start();
        var wall = Stopwatch.StartNew();

        // 8. Boucle des notifications du job jusqu'à « plus aucun processus actif ».
        while (true)
        {
            uint msg; UIntPtr key; IntPtr ov;
            bool got = Native.GetQueuedCompletionStatus(port, out msg, out key, out ov, 20);
            if (timeoutMs > 0 && wall.ElapsedMilliseconds >= timeoutMs) Kill("timeout");
            if (!got) continue;
            long pid = ov.ToInt64();
            if (msg == Native.JOB_OBJECT_MSG_NEW_PROCESS) Emit("{\"event\":\"process-new\",\"pid\":" + pid + "}");
            else if (msg == Native.JOB_OBJECT_MSG_EXIT_PROCESS || msg == Native.JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS) Emit("{\"event\":\"process-exit\",\"pid\":" + pid + "}");
            else if (msg == Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT) Emit("{\"event\":\"active-process-limit\"}");
            else if (msg == Native.JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) Emit("{\"event\":\"job-memory-limit\",\"pid\":" + pid + "}");
            else if (msg == Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) break;
        }
        double killMs = -1;
        lock (Gate) { if (KillRequested) { KillWatch.Stop(); killMs = KillWatch.Elapsed.TotalMilliseconds; } }
        uint exit; Native.GetExitCodeProcess(pi.hProcess, out exit);
        var acct = QueryAccounting();
        Emit("{\"event\":\"done\",\"exitCode\":" + exit + ",\"killReason\":" + Json(KillReason) +
             ",\"killToZeroMs\":" + killMs.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) +
             ",\"totalProcesses\":" + acct.TotalProcesses + ",\"activeProcesses\":" + acct.ActiveProcesses +
             ",\"terminatedProcesses\":" + acct.TotalTerminatedProcesses + ",\"wallMs\":" + wall.ElapsedMilliseconds + "}");
        foreach (var p in allocs) Marshal.FreeHGlobal(p);
        return (int)exit;
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

    static void Update(IntPtr attrs, IntPtr attr, IntPtr value, int size)
    {
        if (!Native.UpdateProcThreadAttribute(attrs, 0, attr, value, (IntPtr)size, IntPtr.Zero, IntPtr.Zero))
            throw new Exception("UpdateProcThreadAttribute 0x" + attr.ToInt64().ToString("x") + " " + Marshal.GetLastWin32Error());
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

    static Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION QueryAccounting()
    {
        int n = Marshal.SizeOf(typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); IntPtr p = Marshal.AllocHGlobal(n);
        try
        {
            Native.QueryInformationJobObject(Job, 1, p, n, IntPtr.Zero);
            return (Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(p, typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        }
        finally { Marshal.FreeHGlobal(p); }
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
