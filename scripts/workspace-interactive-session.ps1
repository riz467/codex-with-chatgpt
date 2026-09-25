# Enumerate local Windows sessions without relying on localized `quser` output.
function Get-WorkspaceInteractiveSessions {
    if (-not ('WorkspaceWts' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WorkspaceWts {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Session { public int Id; [MarshalAs(UnmanagedType.LPWStr)] public string Station; public int State; }
    [DllImport("wtsapi32.dll", EntryPoint = "WTSEnumerateSessionsW", SetLastError = true)]
    private static extern bool Enumerate(IntPtr server, int reserved, int version, out IntPtr buffer, out int count);
    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    private static extern bool Query(IntPtr server, int id, int info, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);
    private static string Text(int id, int info) {
        IntPtr buffer; int bytes;
        if (!Query(IntPtr.Zero, id, info, out buffer, out bytes)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(buffer) ?? ""; } finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
    }
    public static object[] Sessions() {
        IntPtr buffer; int count;
        if (!Enumerate(IntPtr.Zero, 0, 1, out buffer, out count)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var sessions = new List<object>();
        try {
            int size = Marshal.SizeOf(typeof(Session));
            for (int i = 0; i < count; i++) {
                var entry = (Session)Marshal.PtrToStructure(IntPtr.Add(buffer, i * size), typeof(Session));
                if (entry.Id <= 0) continue;
                string user = Text(entry.Id, 5); // WTSUserName
                if (!String.Equals(user, "workspace", StringComparison.OrdinalIgnoreCase)) continue;
                string domain = Text(entry.Id, 7); // WTSDomainName
                sessions.Add(new { SessionId = entry.Id, User = domain + @"\" + user,
                    State = entry.State == 0 ? "Active" : entry.State == 4 ? "Disconnected" : "Other" });
            }
        } finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
        return sessions.ToArray();
    }
}
'@
    }
    [WorkspaceWts]::Sessions()
}
