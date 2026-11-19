# ApkBuddyStart window agent (ASCII only).
# A single long-lived helper that owns every Win32 trick we need:
#   * re-parents the Android emulator Qt window into an ApkBuddyStart BrowserWindow (one clean window,
#     no emulator sidebar, no emulator title bar);
#   * hides the floating emulator toolbar window that shows the volume/camera/back rail;
#   * rotates the device with Ctrl+Left / Ctrl+Right and reports the new window size;
#   * runs an opt-in WH_MOUSE_LL hook so right click becomes Android BACK, wheel
#     becomes a coalesced swipe, and (optionally) side buttons become BACK / FORWARD.
#     Left click is deliberately left alone: Qt already maps it to a finger tap.
# Everything is P/Invoke from the .NET Framework that ships with Windows 10/11,
# so there is no native binary to compile, sign or ship.
# Protocol: TCP on 127.0.0.1, one JSON object per line. First stdout line is "PORT=<n>".
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ApkAgent
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Pt; public int MouseData; public int Flags; public int Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    // Minimal PROCESS_BASIC_INFORMATION: enough to read InheritedFromUniqueProcessId.
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr ParentPid; }

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowTextW(IntPtr h, string s);
    // Poner un icono a la ventana nativa del emulador (en modo de ventana independiente, la barra de tareas/Alt+Tab muestran el icono de la app actual)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImageW(IntPtr inst, string file, uint type, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    // Alto DPI: lo que envía appwin.js son píxeles físicos. Sin declarar compatibilidad DPI, Windows lo trata como píxeles lógicos y lo amplía otra vez,
    // por lo que la ventana del emulador acoplada sale más grande que el anfitrión (1,5× con escalado del 150 %) → la imagen se recorta a la derecha/abajo y los clics se desplazan (issue #40).
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr c);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    // Recortar el área visible de la ventana acoplada: quitar la franja del marco que se apoya sobre la barra de título
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CHILD = 0x40000000;
    const uint WS_POPUP = 0x80000000;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_BORDER = 0x00800000;
    const int WS_CLIPCHILDREN = 0x02000000;
    const int WS_CLIPSIBLINGS = 0x04000000;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;

    static IntPtr _host = IntPtr.Zero;
    static IntPtr _emu = IntPtr.Zero;
    static IntPtr _chromeRender = IntPtr.Zero;
    static IntPtr _hook = IntPtr.Zero;
    static HookProc _hookProc = null;
    static Thread _hookThread = null;
    static volatile bool _hookRun = false;
    static uint _hookTid = 0;
    static readonly ManualResetEvent _hookReady = new ManualResetEvent(false);
    static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    static long _lastToolSweep = 0;
    static long _embedAt = 0;
    // Supresión residente: se activa por defecto al arrancar y mantiene ocultas la ventana principal del emulador + la barra de herramientas + las ventanas negras de consola.
    // A diferencia de la lógica anterior de «apagar al terminar embed», es **permanente**: sweep omite la ventana ya acoplada
    // a nuestra ventana y oculta todas las demás (incluida la ventana negra que vuelve al escritorio tras salir de ApkBuddyStart).
    static volatile bool _quiet = true;
    static volatile bool _perfMode = false;
    static volatile bool _detachedMode = false;
    static long _bootHideSweep = 0;
    // Marca de tiempo de escaneo exclusiva de las ventanas negras de consola. Cuando emulator lanza qemu, Windows abre
    // una ventana de consola nueva (en Win11 es Windows Terminal) que solo vive 200~300 ms; la inspección principal,
    // a 250 ms por pasada, no la caza de forma fiable, así que durante los primeros 15 segundos se barre además
    // el grupo de ventanas de consola con un ritmo más denso.
    static long _consoleSweep = 0;
    // Tiempo de espera de respaldo: si no llega embed (el usuario solo abrió ApkBuddyStart y no pulsó ninguna app),
    // no se puede dejar el escaneo de 120 ms corriendo eternamente quemando CPU. Se renueva cada vez que se oculta una ventana de verdad.
    static long _bootHideUntil = 0;
    static long _bootHideStart = Environment.TickCount;
    // Hora límite (TickCount) de la «guardia» tras desconectarse. Véase la rama sock == null en Serve().
    static long _lingerUntil = 0;

    // Which windows count as "ours": only those created by a process whose exe lives
    // inside one of these directories (the runtime root / bundled engine dir).
    // This is the whole fix for "ApkBuddyStart conflicts with WeChat": WeChat 4.x is Qt 6
    // too (its windows are QWindowIcon / QWindowToolSaveBits), so any matching that
    // relied on window class names alone could hide or even re-parent WeChat's own
    // windows. Class names are never unique; the owning process's path is.
    static readonly System.Collections.Generic.List<string> _scopeDirs = new System.Collections.Generic.List<string>();
    static readonly System.Collections.Generic.Dictionary<uint, bool> _oursCache = new System.Collections.Generic.Dictionary<uint, bool>();
    // PID of the ApkBuddyStart main process. The only window we are ever allowed to embed
    // into / swallow clicks for. Guard against a recycled HWND: if _host later belongs
    // to somebody else, the mouse hook must pass events through instead of eating them.
    static uint _appPid = 0;
    static uint _hostPid = 0;

    // Hook options. All three default to OFF: an "hook on" without options must
    // never swallow anybody's clicks. JS sends the real config on every enable.
    static volatile int _optRight = 0;
    static volatile int _optWheel = 0;
    static volatile int _optSide = 0;

    // Wheel coalescing: Qt would turn every single notch into a separate touch
    // gesture (visible stutter). We accumulate deltas for a short window and
    // hand one normalized position to the JS side, which injects a single swipe.
    static readonly object _wheelLock = new object();
    static int _wheelDx = 0, _wheelDy = 0;
    static double _wheelNx = 0.5, _wheelNy = 0.5;
    static long _wheelFirst = 0, _wheelLast = 0;

    // ------------------------------------------------------------------ ownership
    // Scope is set by the JS side before anything is hidden ("scope" command).
    // With no scope the agent refuses to touch any window: leaving one black console
    // around is a cosmetic bug, hiding a user's WeChat window is not.
    static void SetScope(string raw)
    {
        _scopeDirs.Clear();
        string[] pieces = (raw == null ? "" : raw).Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            string d = piece.Trim();
            if (d.Length == 0) continue;
            try { d = System.IO.Path.GetFullPath(d); } catch { }
            if (!d.EndsWith("\\")) d += "\\";
            _scopeDirs.Add(d.ToLowerInvariant());
        }
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static bool IsOurs(uint pid)
    {
        if (pid == 0 || _scopeDirs.Count == 0) return false;
        lock (_oursCache)
        {
            bool hit;
            if (_oursCache.TryGetValue(pid, out hit)) return hit;
        }
        bool ours = false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                string file = null;
                try { file = p.MainModule.FileName; } catch { file = null; }
                if (!string.IsNullOrEmpty(file))
                {
                    string low = file.ToLowerInvariant();
                    for (int i = 0; i < _scopeDirs.Count; i++)
                        if (low.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) { ours = true; break; }
                }
            }
        }
        catch { ours = false; }
        lock (_oursCache)
        {
            // PIDs get recycled; a bounded cache is enough (one entry per live process).
            if (_oursCache.Count > 400) _oursCache.Clear();
            _oursCache[pid] = ours;
        }
        return ours;
    }

    static uint ParentOf(uint pid)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return 0;
            PBI pbi = new PBI();
            int len;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return 0;
            return (uint)pbi.ParentPid.ToInt64();
        }
        catch { return 0; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    // Console windows belong to conhost.exe, not to the program that owns the console,
    // so the window pid is never the emulator's. Walk conhost's parents instead.
    static bool ConsoleOwnedByUs(uint pid)
    {
        uint p = ParentOf(pid);
        for (int i = 0; i < 3 && p != 0; i++)
        {
            if (IsOurs(p)) return true;
            p = ParentOf(p);
        }
        return false;
    }

    static bool IsOurConsole(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (IsOurs(pid) || ConsoleOwnedByUs(pid)) return true;
        if (_scopeDirs.Count == 0) return false;
        // Windows titles a console with the image path it launched, so the runtime
        // directory shows up verbatim. Precise enough to never match a stray terminal.
        string title = TitleOf(h).ToLowerInvariant();
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (title.IndexOf(_scopeDirs[i], StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // ------------------------------------------------------------------ window discovery
    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }
    static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // The emulator draws its framebuffer in a "QWindowIcon" top level window titled
    // "Android Emulator - <avd>:<port>"; the volume/rotate rail lives in a separate
    // small "QWindowTool*" window we hide.
    //
    // Nota: durante el arranque del emulador (y después de que la supresión residente la oculte), esta ventana es **invisible**,
    // así que aquí no se puede seguir filtrando por IsWindowVisible: si no, nunca se encontraría una ventana acoplable y
    // el usuario vería una ventana de aplicación toda negra. En su lugar: «si el título es Android Emulator, se acepta;
    // se prefieren las ventanas grandes visibles». La barra de herramientas / ventanas de aviso (QWindowTool) son demasiado pequeñas y las descarta el umbral de área.
    //
    // ApkBuddyStart cambia el título de esta ventana al nombre de la app (véase el comando "title"), así que al identificarla
    // hay que reconocer también «el título renombrado». Se usa un campo volatile para recordar el título que pusimos.
    public static string _ourTitle = "";
    // Ruta del archivo de icono de la app: Qt restaura el icono por defecto (el robot verde) al recrear la ventana; la inspección lo vuelve a poner continuamente.
    public static string _ourIconFile = "";
    public static IntPtr _ourIconSmall = IntPtr.Zero;
    public static IntPtr _ourIconBig = IntPtr.Zero;
    static bool LooksLikeEmulator(string title)
    {
        if (title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (_ourTitle.Length > 0 && String.Equals(title, _ourTitle, StringComparison.Ordinal)) return true;
        return false;
    }
    static IntPtr FindEmulator()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            // Ownership comes first. "QWindowIcon" is the class of EVERY Qt top level
            // window, and WeChat 4.x / MuMu / music players are Qt too -- matching on
            // the class alone is how the wrong window ended up hidden or re-parented.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowIcon", StringComparison.Ordinal) < 0) return true;
            string title = TitleOf(h);
            bool named = LooksLikeEmulator(title);
            if (!named && !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area < 200 * 200) return true;   // La barra de herramientas / el aviso no son ventanas de imagen
            // Primero las ventanas grandes visibles, y solo después las ocultas
            long score = area + (IsWindowVisible(h) ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // Para diagnóstico: listar las ventanas de nivel superior (clase / título / pid / tamaño / visibilidad).
    // Sirve para verificar que «al abrir el programa solo se ve la interfaz del programa»: ni la ventana principal del emulador ni la consola de netsim deben aparecer.
    static string ListWindows(bool includeHidden)
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            bool vis = IsWindowVisible(h);
            if (!vis && !includeHidden) return true;
            string cls = ClassOf(h);
            string title = TitleOf(h);
            // Hay demasiadas ventanas ocultas (cientos o miles en el sistema); solo se miran las relacionadas con el emulador/Qt
            if (!vis && cls.IndexOf("QWindow", StringComparison.Ordinal) < 0
                && title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.R - r.L, hh = r.B - r.T;
            if (vis && (w < 40 || hh < 40)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"w\":").Append(w)
              .Append(",\"h\":").Append(hh)
              .Append(",\"vis\":").Append(vis ? "true" : "false")
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static void HideToolWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowTool", StringComparison.Ordinal) < 0) return true;
            // QWindowToolSaveBits is what Qt uses for menus, tooltips and popup panels --
            // WeChat's emoji panel / right-click menu included. Only hide our own.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) > 200) return true;   // the framebuffer window also uses this class
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Fase de arranque: ocultar las ventanas negras de consola de qemu / emulator para evitar que aparezca la «ventana de comandos».
    // Son procesos del subsistema console, y el windowsHide de Node no cubre los procesos hijos: solo se pueden contener con Win32 de forma periódica.
    //
    // Trampa clave: a partir de Windows 10, la ventana de consola pertenece realmente a conhost.exe, y GetWindowThreadProcessId
    // devuelve el pid de conhost, no el de emulator; la implementación antigua filtraba por lista blanca de pid,
    // así que no lograba ocultar ninguna de estas ventanas negras (de ahí «haces clic y no pasa nada, primero sale un cmd negro»).
    // Ahora se usa «pid coincide O título de ventana coincide (el título es la ruta del exe iniciado)»: con que una de las dos vías funcione, se oculta.
    static void HideConsoleWindows()
    {
        if (_scopeDirs.Count == 0) return;   // no scope: never touch anybody's terminal

        // Primero se barre qué ventanas de consola hay; si no hay ninguna, no se enumeran procesos (GetProcessesByName no es barato)
        var consoles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                consoles.Add(h);
            return true;
        }, IntPtr.Zero);
        if (consoles.Count == 0) return;

        // La implementación antigua tenía además una regla: «si el título contiene emulator / qemu / netsim, es nuestra»,
        // lo que ocultaba también el terminal que el propio usuario hubiera abierto (con un título que es una ruta, p. ej. D://Android//emulator).
        // Ahora solo se aceptan dos pruebas: que la cadena de procesos padres de conhost llegue a nuestro directorio de runtime,
        // o que el título contenga la ruta absoluta de nuestro directorio de runtime (Windows usa la ruta de la imagen como título de consola).
        long now = Environment.TickCount;
        foreach (IntPtr h in consoles)
        {
            if (IsOurConsole(h)) { ShowWindow(h, 0); continue; }
            // Tercera prueba (solo en Windows 11): al cambiar el host de consola por defecto a Windows Terminal,
            // la ventana de consola nueva que el emulador abre para qemu pertenece a WindowsTerminal.exe:
            // el pid no es nuestro, la cadena de padres no llega a nosotros y el título suele ser solo "Terminal",
            // así que las dos pruebas anteriores fallan y en cada arranque parpadea un recuadro negro 200~300 ms en pantalla.
            // Aquí se exigen tres condiciones a la vez: «no existía antes del arranque + aparece en los 20 s posteriores + el título está vacío o es Terminal».
            // El terminal que el usuario abre por su cuenta normalmente ya tiene título (PowerShell, una ruta), así que no se ve afectado;
            // y en el peor de los casos, si se ocultara, no se cerraría su proceso.
            if (_bootHideStart != 0 && now - _bootHideStart < 20000
                && !_consolesBeforeBoot.Contains(h.ToInt64()))
            {
                string t = TitleOf(h);
                string tl = t.ToLowerInvariant();
                // El título cambia en la práctica: puede estar vacío, ser "Terminal" o "Windows Terminal"
                // (según la versión de WT y de si había conseguido el título del shell). Aquí solo se exige «parecer un host de consola»:
                // título vacío, o título que contenga terminal.
                // Los terminales que el usuario ya tenía abiertos están en _consolesBeforeBoot, así que no se tocan;
                // y si aun así se ocultara uno, no se cerraría su proceso.
                bool plain = t.Length == 0 || tl.IndexOf("terminal", StringComparison.Ordinal) >= 0;
                if (plain)
                {
                    ShowWindow(h, 0);
                }
            }
        }
    }

    // Registrar «las ventanas de consola que ya existían en el momento del arranque (boothide)».
    // Windows Terminal mete nuestra consola de qemu en una ventana nueva cuyo dueño no se reconoce por pid /
    // proceso padre / título; usar «no estaba antes del arranque y apareció después» es lo más fiable.
    static System.Collections.Generic.HashSet<long> _consolesBeforeBoot =
        new System.Collections.Generic.HashSet<long>();

    static void SnapshotConsoles()
    {
        _consolesBeforeBoot.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                _consolesBeforeBoot.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
    }

    // Para diagnóstico: listar las ventanas de consola «visibles» actuales (ventanas negras) y su dueño, para los scripts de verificación de tools.
    // ours=true significa que es la ventana de consola de emulator/qemu.
    static string ListConsoles()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            bool isConsole = cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0;
            if (!isConsole) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string title = TitleOf(h);
            bool ours = IsOurConsole(h);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"ours\":").Append(ours ? "true" : "false")
              .Append(",\"pid\":").Append(pid)
              .Append(",\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static string JsonStr(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s == null ? "" : s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c >= ' ') b.Append(c);
        }
        b.Append("\"");
        return b.ToString();
    }

    // Respaldo: ocultar cualquier ventana superior visible **sobrante** creada por nuestros procesos de runtime.
    // Aparte de la ventana principal del emulador (que hay que acoplar), emulator / qemu / netsimd / adb pueden
    // mostrar cosas que parpadean un instante (avisos Qt, diálogos de error, barras de volumen, ventanas de log…).
    // Antes se nombraban clases una a una y si se escapaba una, parpadeaba; ahora se decide por «el proceso pertenece a nuestro directorio de runtime»,
    // con cobertura más amplia. La ventana anfitriona y la del emulador no entran en este ámbito: nunca se tocan.
    static void HideStrayWindows()
    {
        if (_scopeDirs.Count == 0) return;
        IntPtr embeddedRoot = _emu;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            if (h == embeddedRoot) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsOurs(pid)) return true;
            string cls = ClassOf(h);
            // Solo se ocultan las ventanas claramente emergentes: avisos Qt / diálogos / consola.
            // Nunca se tocan QWindowIcon / subWin: es la LCD que se está acoplando; ocultarla dejaría todo negro y los clics sin efecto.
            bool safe = cls.IndexOf("QWindowTool", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("Qt", StringComparison.Ordinal) < 0 && cls.IndexOf("Chrome", StringComparison.Ordinal) < 0;
            if (!safe) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) < 8 && (r.B - r.T) < 8) return true;
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Escaneo de supresión residente: mientras la ventana del emulador no sea «hija de una de nuestras ventanas», se oculta.
    // Así, tanto si el emulador está arrancando o precalentando como si ApkBuddyStart ya salió (la ventana vuelve al escritorio
    // y recupera categoría de superior), el usuario no ve esa ventana negra llamada "Android Emulator - apkstart5554".
    // Al mismo tiempo se mantienen ocultas la barra de herramientas (QWindowTool) y todas las ventanas de consola (qemu / netsimd / emulator).

    // Justo en el momento de embed, es posible que la ventana de renderizado web de Electron aún no exista y FindChromeRender devuelva 0,
    // por lo que el simulador queda colgado como hijo directo del anfitrión (hermano de la capa web): la capa web sigue
    // tapando la imagen y capturando el ratón. Aquí se vuelve a colgar en el escaneo residente: en cuanto aparece la capa web, se reacopla.
    static void EnsureReparent()
    {
        if (_emu == IntPtr.Zero || _host == IntPtr.Zero) return;
        if (_chromeRender == IntPtr.Zero || !IsWindow(_chromeRender))
            _chromeRender = FindChromeRender(_host);
        if (_chromeRender == IntPtr.Zero) return;
        IntPtr ep = GetParent(_emu);
        if (ep == _chromeRender) return;
        if (ep != _host && ep != IntPtr.Zero) return;   // Es otro anfitrión, no se toca
        RECT r;
        if (!GetWindowRect(_emu, out r)) return;
        RECT hr;
        if (!GetWindowRect(_host, out hr)) return;
        SetParent(_emu, _chromeRender);
        // Coordenadas relativas al área cliente de la capa web (igual que el área cliente del anfitrión); se conserva la posición original en pantalla
        SetWindowPos(_emu, IntPtr.Zero, r.L - hr.L, r.T - hr.T,
                     r.R - r.L, r.B - r.T, 0x0004 | 0x0010 | 0x0040);
    }

    static void QuietSweep()
    {
        // Modo de ventana independiente: la ventana del emulador es «la que el usuario está viendo de verdad», no se puede suprimir,
        // ni hay que ajustarla al área cliente del anfitrión. Aquí se omiten todas las rutinas de supresión directamente.
        if (_detachedMode)
        {
            // Qt restaura el título a "Android Emulator - ..." al cambiar la resolución o recrear la ventana.
            // Cada pasada lo vuelve a poner, para que la barra de tareas muestre siempre ApkBuddyStart (o el nombre de la app).
            if (_ourTitle.Length > 0 && _emu != IntPtr.Zero
                && !String.Equals(TitleOf(_emu), _ourTitle, StringComparison.Ordinal))
                SetWindowTextW(_emu, _ourTitle);
            // Al cambiar de resolución o recrear la ventana, Qt devuelve el icono al robot verde por defecto; se repone en cada pasada.
            // Si WM_GETICON devuelve un valor distinto de cero, la ventana ya tiene el icono que pusimos y se omite; si no, se reenvía el handle cacheado.
            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero)
                && SendMessageW(_emu, 0x007F, new IntPtr(1), IntPtr.Zero) == IntPtr.Zero)
            {
                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
            }
            HideConsoleWindows();
            HideStrayWindows();
            return;
        }
        EnsureReparent();
        // Autocorrección de tamaño: al maximizar/escalar el anfitrión, la capa chrome de Electron a menudo no crece con él,
        // y la imagen queda reducida a una franja en la esquina superior izquierda. Aquí se reajusta en cada pasada
        // (Fit recalcula según el área cliente del anfitrión; si el tamaño no cambió, SetWindowPos apenas cuesta).
        if (_emu != IntPtr.Zero && _host != IntPtr.Zero) Fit(-8, 30, 640, 480, false, 0);
        IntPtr ep = _emu != IntPtr.Zero ? GetParent(_emu) : IntPtr.Zero;
        bool embedded = _emu != IntPtr.Zero && ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        IntPtr e = embedded ? _emu : FindEmulator();
        if (!embedded && e != IntPtr.Zero && IsWindowVisible(e)) ShowWindow(e, 0);
        HideToolWindows();
        HideConsoleWindows();
        HideStrayWindows();
        if (!embedded && e != IntPtr.Zero) _bootHideUntil = Environment.TickCount + 5000;
    }

    // Only our own runtime counts. The old version returned true for ANY process named
    // "emulator" -- other emulators (MuMu / LDPlayer ship their own) kept the guard alive.
    static bool AnyEmulatorProcess()
    {
        if (_scopeDirs.Count == 0) return false;
        try
        {
            string[] names = { "qemu-system-x86_64", "qemu-system-x86_64-headless", "emulator", "emulator-headless", "netsimd" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] all = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < all.Length; j++)
                    if (IsOurs((uint)all[j].Id)) return true;
            }
        }
        catch { }
        return false;
    }

    // ------------------------------------------------------------------ embed / detach

    // Encontrar la ventana de renderizado de Chromium dentro de la ventana anfitriona.
    // Si la capa web de Electron (Chrome_RenderWidgetHostHWND) y la ventana del emulador son ambas hijas directas del anfitrión,
    // son «hermanas» y Electron eleva continuamente la capa web al frente: el fondo negro de la capa web tapa la imagen de Android
    // y se come todos los clics (los «bordes negros / no llena / clics sin efecto / no se puede pulsar Aceptar» que ve el usuario vienen de aquí).
    // Al colgar el emulador como **hija** de la capa web, el orden Z y la captura de ratón favorecen de forma natural al emulador.
    static IntPtr FindChromeRender(IntPtr host)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(host, delegate(IntPtr c, IntPtr p)
        {
            if (ClassOf(c).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.Ordinal) >= 0)
            {
                found = c;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static bool Embed(IntPtr host, IntPtr emu)
    {
        if (host == IntPtr.Zero || emu == IntPtr.Zero) return false;
        HideToolWindows();
        // La ventana hija de la capa web cubre todo el área cliente del anfitrión y usa el mismo sistema de coordenadas, así que el rectángulo que pasa Fit después no hay que cambiarlo.
        IntPtr parent = FindChromeRender(host);
        if (parent == IntPtr.Zero) parent = host;   // Si no se encuentra, se vuelve al comportamiento anterior; que no falle la apertura de la app
        SetParent(emu, parent);
        uint style = (uint)GetWindowLong(emu, GWL_STYLE);
        style &= ~WS_POPUP;
        style &= ~(uint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER);
        style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        SetWindowLong(emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(emu, GWL_EXSTYLE);
        ex &= ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
        SetWindowLong(emu, GWL_EXSTYLE, ex);
        // Las versiones antiguas pusieron un window region a esta ventana; al reutilizarla, hay que limpiarlo antes, o las pruebas de acierto seguirán desplazadas
        SetWindowRgn(emu, IntPtr.Zero, false);
        return true;
    }

    // HWND_TOP: la ventana de renderizado de Chromium y el emulador son hijas del mismo nivel;
    // si no se eleva activamente al frente, el fondo negro de Chromium tapa la imagen (lo que el usuario ve es una pantalla negra).
    static readonly IntPtr HWND_TOP = new IntPtr(1);
    static void Fit(int x, int y, int w, int h, bool frame, int clipTop)
    {
        if (_emu == IntPtr.Zero) return;
        // Fit lo llama el lado JS en cada resize, y para entonces la capa web ya existe sin falta.
        // Se garantiza que el emulador quede por debajo de la capa web (si son hermanas, la capa web lo tapa y le come el ratón).
        if (_host != IntPtr.Zero)
        {
            IntPtr cr = FindChromeRender(_host);
            if (cr != IntPtr.Zero)
            {
                _chromeRender = cr;
                IntPtr cur = GetParent(_emu);
                if (cur != cr && (cur == _host || cur == IntPtr.Zero))
                {
                    SetParent(_emu, cr);
                    // Coordenadas relativas al área cliente de la capa web, igual que el anfitrión; se reutilizan los x/y recibidos
                }
            }
        }
        // Autocorrección de tamaño usando **el área cliente de la ventana anfitriona** como referencia, sin fiarse de los w/h que pasa JS
        // ni del tamaño propio de la capa de renderizado de Chrome.
        //
        // Por qué: al maximizar Electron, la ventana anfitriona pasa a 1936x1048, pero el
        // Chrome_RenderWidgetHostHWND sigue en el tamaño antiguo (medido 532x984), y como la ventana del emulador
        // cuelga por debajo de la capa chrome, el padre la recorta: la imagen solo ocupa una franja arriba a la izquierda y
        // queda un gran espacio en blanco a la derecha (lo que el usuario captura como «al maximizar/a pantalla completa no llena»).
        // Por eso primero se estira la capa chrome a todo el área cliente del anfitrión y luego se fija el emu a ese tamaño de cliente.
        if (_host != IntPtr.Zero)
        {
            RECT hc;
            if (GetClientRect(_host, out hc))
            {
                int cw = hc.R - hc.L;
                int chh = hc.B - hc.T;
                if (cw > 200 && chh > 200)
                {
                    if (_chromeRender != IntPtr.Zero)
                    {
                        RECT crc;
                        if (GetWindowRect(_chromeRender, out crc))
                        {
                            if ((crc.R - crc.L) != cw || (crc.B - crc.T) != chh)
                            {
                                SetWindowPos(_chromeRender, IntPtr.Zero, 0, 0, cw, chh,
                                    SWP_NOZORDER | SWP_NOACTIVATE);
                            }
                        }
                    }
                    // x/y mantienen el desbordamiento de -8 (para sacar el borde gris de 8 px de Qt del área visible),
                    // el ancho y alto son el área cliente + 2*8; la barra de título de 38 px la cubre el anfitrión con su propio dibujo.
                    x = -8;
                    y = 38 - 8;
                    w = cw + 16;
                    h = (chh - 38) + 16;
                }
            }
        }
        if (w < 16) w = 16;
        if (h < 16) h = 16;
        // Solo se permite mostrar lo «realmente acoplado a nuestra ventana».
        // Si embed falla (la ventana del emulador aún no se creó / cambió el handle), Fit no debe tratarlo como ventana independiente
        // y sacarlo al escritorio: esa es justo la ventana negra "Android Emulator - apkstart5554" que ve el usuario.
        IntPtr ep = GetParent(_emu);
        bool embedded = ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        if (!embedded)
        {
            ShowWindow(_emu, 0);
            return;
        }
        // SWP_FRAMECHANGED forces Windows to recompute the whole non-client area and
        // repaint it. It is needed exactly once (right after SetParent); repeating it
        // on every periodic sweep caused visible stutter and wasted GPU/CPU.
        uint flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (frame ? SWP_FRAMECHANGED : 0u);
        SetWindowPos(_emu, HWND_TOP, x, y, w, h, flags);
        // Nunca se pone window region a la ventana acoplada: en cuanto una ventana hija Qt/GL lleva region, las pruebas de acierto y
        // el mapeo de coordenadas de entrada se desplazan (clics sin efecto / no se pulsan los botones), y tras girar/cambiar tamaño la region sigue siendo el
        // rectángulo viejo y vuelven a aparecer bordes negros alrededor. La franja de 8 px sobre la barra de título la cubre la barra que dibuja el anfitrión.
    }

    static void Raise()
    {
        if (_emu == IntPtr.Zero) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void Detach()
    {
        if (_emu == IntPtr.Zero) return;
        SetParent(_emu, IntPtr.Zero);
        uint style = (uint)GetWindowLong(_emu, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLong(_emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(_emu, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(_emu, GWL_EXSTYLE, ex);
        SetWindowPos(_emu, IntPtr.Zero, 60, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        // En modo de ventana independiente hay que conservar el handle: show / layout lo usan para localizar la ventana real.
        // El modo acoplado (por defecto) sigue vaciándolo, para mantener la semántica original.
        if (!_detachedMode) _emu = IntPtr.Zero;
    }

    // Igual que Detach, pero **sin mostrar** la ventana: se llama cuando la ventana anfitriona está a punto de destruirse.
    // Si no se desacopla antes, Windows vuelve a colgar la ventana hija en el escritorio y la pone visible,
    // y aparece de la nada una ventana negra "Android Emulator - apkstart5554".
    static void ParkEmulator()
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        IntPtr e = _emu;
        if (e == IntPtr.Zero) { _host = IntPtr.Zero; return; }
        ShowWindow(e, 0);
        SetParent(e, IntPtr.Zero);
        uint style = (uint)GetWindowLong(e, GWL_STYLE);
        style &= ~WS_CHILD;
        // Se repone también WS_VISIBLE(0x10000000): pudo borrarse implícitamente al hacer SetParent a un anfitrión oculto,
        // y las bases de terceros (MuMu) no la vuelven a mostrar por su cuenta, así que al cerrar la ventana de la app el usuario ya no vería el emulador.
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | 0x10000000);
        SetWindowLong(e, GWL_STYLE, (int)style);
        int ex = GetWindowLong(e, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(e, GWL_EXSTYLE, ex);
        SetWindowPos(e, IntPtr.Zero, 40, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        _emu = IntPtr.Zero;
        _host = IntPtr.Zero;
    }

    // ------------------------------------------------------------------ rotation
    // El cambio de orientación del emulador es «cambiar la orientación del panel», y solo lo dispara su propio atajo Qt Ctrl+←/→;
    // el comando de consola adb emu rotate solo gira la imagen 90°, pero el sistema sigue en vertical (la imagen queda tumbada).
    // Lo difícil es que el atajo debe recibirlo la ventana del emulador como mensaje de teclado, y ya es hija de nuestra ventana,
    // con el foco en la capa web. Así que se conectan las colas de entrada de los dos hilos, se le da el foco al emulador temporalmente,
    // y tras pulsar la tecla se devuelve.
    static void Rotate(string dir)
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        if (_emu == IntPtr.Zero) return;
        // keybd_event feeds the SYSTEM input queue, so if we are not the foreground
        // window the Ctrl+Left lands in whatever the user is typing in (WeChat's input
        // box, a browser, ...). Rotate is a user action in our own window; if we are
        // not foreground, do nothing instead of typing into someone else's app.
        IntPtr fg = GetForegroundWindow();
        if (_host == IntPtr.Zero || (fg != IntPtr.Zero && GetAncestor(fg, 2) != _host)) return;
        IntPtr host = _host != IntPtr.Zero ? _host : GetParent(_emu);

        uint emuTid, hostTid, dummy;
        emuTid = GetWindowThreadProcessId(_emu, out dummy);
        hostTid = host != IntPtr.Zero ? GetWindowThreadProcessId(host, out dummy) : 0;
        uint myTid = GetCurrentThreadId();

        bool a1 = AttachThreadInput(myTid, emuTid, true);
        bool a2 = hostTid != 0 && AttachThreadInput(myTid, hostTid, true);
        try
        {
            if (host != IntPtr.Zero) SetForegroundWindow(host);
            IntPtr prev = SetFocus(_emu);
            Thread.Sleep(150);
            byte vk = dir == "right" ? (byte)0x27 : (byte)0x25;
            keybd_event(0x11, 0, 0, IntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(vk, 0, 0, IntPtr.Zero);
            Thread.Sleep(80);
            keybd_event(vk, 0, 2, IntPtr.Zero);
            keybd_event(0x11, 0, 2, IntPtr.Zero);
            Thread.Sleep(120);
            SetFocus(prev);
        }
        finally
        {
            if (a2) AttachThreadInput(myTid, hostTid, false);
            if (a1) AttachThreadInput(myTid, emuTid, false);
        }
    }

    // ------------------------------------------------------------------ mouse mapping
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_RBUTTONUP = 0x0205;
    const int WM_RBUTTONDBLCLK = 0x0206;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;
    const int WM_XBUTTONUP = 0x020C;
    const int WM_MOUSEHWHEEL = 0x020E;

    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long NowMs() { return _clock.ElapsedMilliseconds; }

    // Only react inside the embedded LCD while OUR window is the foreground root.
    // GetAncestor(GA_ROOT) covers Chromium child windows and the Qt framebuffer.
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || _host == IntPtr.Zero) return false;
        // HWNDs get recycled. If "our" host is gone (or now belongs to another process)
        // the hook must not swallow anything -- otherwise right click / wheel silently
        // stop working in whichever app inherited the handle.
        if (!IsWindow(_host)) return false;
        if (_appPid != 0 && _hostPid != 0 && _hostPid != _appPid) return false;
        if (GetAncestor(fg, 2) != _host) return false;   // 2 = GA_ROOT
        IntPtr e = _emu;
        if (e != IntPtr.Zero && GetWindowRect(e, out r))
        {
            // Qt keeps an 8px grey pad around the real LCD; embed() pushes it out.
            return pt.X >= r.L + 8 && pt.X <= r.R - 8 && pt.Y >= r.T + 8 && pt.Y <= r.B - 8;
        }
        // Before embed (or if FindEmulator failed) fall back to the host window
        // minus its 38px title bar. Approximate on HiDPI, but only a fallback.
        if (!GetWindowRect(_host, out r)) return false;
        return pt.X >= r.L + 4 && pt.X <= r.R - 4 && pt.Y >= r.T + 40 && pt.Y <= r.B - 4;
    }

    static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

    static void PushWheel(int dx, int dy, POINT pt, RECT r)
    {
        int w = r.R - r.L - 16, h = r.B - r.T - 16;
        double nx = w > 0 ? (pt.X - r.L - 8.0) / w : 0.5;
        double ny = h > 0 ? (pt.Y - r.T - 8.0) / h : 0.5;
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) _wheelFirst = now;
            _wheelDx += dx;
            _wheelDy += dy;
            _wheelNx = nx;
            _wheelNy = ny;
            _wheelLast = now;
        }
    }

    // Drained from the socket loop. Emit after 60ms of quiet, but never let a
    // continuous spin starve the queue (hard cap 90ms from the first notch).
    static void FlushWheel(bool force)
    {
        int dx = 0, dy = 0;
        double nx = 0.5, ny = 0.5;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) return;
            if (!force && now - _wheelLast < 60 && now - _wheelFirst < 90) return;
            dx = _wheelDx; dy = _wheelDy; nx = _wheelNx; ny = _wheelNy;
            _wheelDx = 0; _wheelDy = 0;
        }
        _events.Enqueue("{\"ev\":\"wheel\",\"dx\":" + dx + ",\"dy\":" + dy
            + ",\"nx\":" + Num(nx) + ",\"ny\":" + Num(ny) + "}");
    }

    static void ResetWheel()
    {
        lock (_wheelLock) { _wheelDx = 0; _wheelDy = 0; }
    }

    // The callback must stay microscopic: Windows synchronously waits for it on
    // EVERY mouse event of EVERY process. Anything not one of our 7 messages
    // (including all left-button events) is a single CallNextHookEx.
    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            bool right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK;
            bool wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
            bool xbut = msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP;
            if (!right && !wheel && !xbut) return CallNextHookEx(_hook, nCode, wParam, lParam);
            if ((right && _optRight == 0) || (wheel && _optWheel == 0) || (xbut && _optSide == 0))
                return CallNextHookEx(_hook, nCode, wParam, lParam);

            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT r;
            if (!InOurLcd(d.Pt, out r)) return CallNextHookEx(_hook, nCode, wParam, lParam);

            if (right)
            {
                // Qt maps a right click to a plain finger tap: swallow it, emit BACK.
                if (msg == WM_RBUTTONDOWN) _events.Enqueue("{\"ev\":\"back\"}");
                return (IntPtr)1;
            }
            if (wheel)
            {
                int delta = (short)((d.MouseData >> 16) & 0xFFFF);
                if (msg == WM_MOUSEWHEEL) PushWheel(0, delta, d.Pt, r);
                else PushWheel(delta, 0, d.Pt, r);
                return (IntPtr)1;
            }
            if (msg == WM_XBUTTONDOWN)
            {
                int button = (d.MouseData >> 16) & 0xFFFF;
                _events.Enqueue(button == 1 ? "{\"ev\":\"back\"}" : "{\"ev\":\"forward\"}");
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    // A WH_MOUSE_LL hook is global: Windows synchronously waits for this callback on
    // EVERY mouse event of EVERY application. It must therefore live on a thread whose
    // only job is pumping messages. Installing it on the socket-serving thread (which
    // used to block up to 4s in Poll) made the whole desktop pointer lag and drift.
    // It is scoped now: JS installs it only while an app window is foreground, and
    // the callback ignores events outside the embedded LCD.
    static void HookThreadProc()
    {
        _hookTid = GetCurrentThreadId();
        _hookProc = HookCallback;
        _hook = SetWindowsHookEx(14, _hookProc, IntPtr.Zero, 0);
        _hookReady.Set();
        MSG m;
        while (_hookRun && GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _hookTid = 0;
    }

    static void HookOn()
    {
        if (_hookThread != null && _hookThread.IsAlive) return;
        _hookRun = true;
        _hookReady.Reset();
        _hookThread = new Thread(HookThreadProc);
        _hookThread.IsBackground = true;
        _hookThread.Start();
        // Reply must reflect the real hook state; otherwise the JS side sees
        // hooked:false and thinks enabling failed.
        _hookReady.WaitOne(1000);
    }
    static void HookOff()
    {
        _hookRun = false;
        _optRight = 0; _optWheel = 0; _optSide = 0;
        ResetWheel();
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        if (_hookTid != 0) PostThreadMessage(_hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        _hookThread = null;
        // Se conserva deliberadamente la referencia a _hookProc: el hilo del hook puede estar ejecutando la callback y ponerlo a null antes
        // permite que el delegado sea recogido por el GC. El hilo lo libera de forma natural al salir.
    }

    // ------------------------------------------------------------------ plumbing
    static void Pump()
    {
        MSG m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static long L(string line, string key)
    {
        string pat = "\"" + key + "\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = line.IndexOf(':', i + pat.Length);
        if (i < 0) return 0;
        i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\"')) i++;
        int j = i;
        while (j < line.Length && (char.IsDigit(line[j]) || line[j] == '-')) j++;
        long v;
        return long.TryParse(line.Substring(i, j - i), out v) ? v : 0;
    }

    static string S(string line, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return "";
        i += pat.Length;
        int j = line.IndexOf('"', i);
        return j < 0 ? "" : line.Substring(i, j - i);
    }

    // Analizar "0x1A2B3C" / "17158972" como HWND. Las bases de terceros (MuMu) informan de cadenas hexadecimales,
    // y nuestros propios llamadores pueden pasar el valor directamente en decimal; hay que aceptar ambos.
    static IntPtr ParseHwnd(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return IntPtr.Zero;
        string s = raw.Trim();
        long v = 0;
        try
        {
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                v = Convert.ToInt64(s.Substring(2), 16);
            }
            else if (long.TryParse(s, out v))
            {
                // Si es decimal, se trata como decimal
            }
            else
            {
                v = Convert.ToInt64(s, 16);
            }
        }
        catch { return IntPtr.Zero; }
        if (v <= 0) return IntPtr.Zero;
        return new IntPtr(v);
    }

    static void Reply(Socket s, string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            s.Send(b);
        }
        catch { }
    }

    public static void Serve(int port)
    {
        // por-monitor v2 (Win10 1703+), si falla se recurre a system-aware
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        TcpListener l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        int actual = ((IPEndPoint)l.LocalEndpoint).Port;
        Console.WriteLine("PORT=" + actual);
        Console.Out.Flush();
        Socket sock;
        try { sock = l.AcceptSocket(); }
        catch { return; }
        l.Stop();

        StringBuilder rx = new StringBuilder();
        byte[] buf = new byte[8192];
        bool run = true;
        while (run)
        {
            Pump();
            FlushWheel(false);

            string ev;
            while (_events.TryDequeue(out ev))
                Reply(sock, "{\"ev\":\"" + ev + "\"}");

            // The Qt tool rail can re-appear right after embedding. Sweep only for the
            // first few seconds after an embed, then stop: a permanent 2s EnumWindows +
            // SetWindowPos loop is pure overhead and competes with the foreground app.
            long now = Environment.TickCount;
            if (_embedAt != 0 && now - _embedAt < 8000 && now - _lastToolSweep > 1500)
            {
                _lastToolSweep = now;
                HideToolWindows();
                Raise();
            }
            if (_embedAt != 0 && now - _embedAt >= 8000) _embedAt = 0;

            // Supresión residente: ventana principal del emulador / barra de herramientas / ventanas negras de consola de qemu·netsimd.
            // Cada pasada hay que enumerar varias veces todas las ventanas del escritorio, lo que no es barato: antes, a 120 ms durante 90 s,
            // ralentizaba todo el equipo de forma notable (los usuarios decían «el sistema entero va lento»). En realidad, una vez acoplada la ventana
            // no hace falta tanta frecuencia: los primeros 10 s a 250 ms para cazar ventanas fugaces y después 1500 ms de respaldo.
            // En modo game (_perfMode) se baja aún más a 3000 ms, dejando toda la CPU para el renderizado de Android.
            long sweepGap;
            if (_perfMode) sweepGap = (now - _bootHideStart < 10000) ? 300 : 3000;
            else sweepGap = (now - _bootHideStart < 10000) ? 250 : 1500;
            if (_quiet && now - _bootHideSweep > sweepGap)
            {
                _bootHideSweep = now;
                QuietSweep();
            }

            // Canal de alta frecuencia exclusivo para ventanas negras de consola (solo los primeros 15 s, solo ventanas de consola).
            // Por qué hace falta: al arrancar qemu, Windows crea una ventana de consola nueva,
            // cuyo proceso dueño es conhost / WindowsTerminal y IsOurs da false, así que solo se reconoce con
            // IsOurConsole («título = nuestra ruta de runtime»). Estas ventanas solo son visibles
            // 200~300 ms y la inspección principal, a 250 ms por pasada, tiene probabilidad de perderlas: el usuario ve
            // un parpadeo negro al arrancar. Aquí se barre cada 100 ms y se caza seguro antes de que desaparezca.
            if (_quiet && now - _bootHideStart < 15000
                && now - _consoleSweep > (_perfMode ? 200 : 100))
            {
                _consoleSweep = now;
                HideConsoleWindows();
            }

            try
            {
                // La conexión ya se cortó (ApkBuddyStart salió / hubo un fallo): no se recoge aún.
                // El emulador puede seguir arrancando y Qt no mostrar la ventana hasta decenas de segundos después; si para entonces
                // no queda ningún agente vigilando, se quedaría una ventana negra de Android Emulator en el escritorio.
                // Por eso se sigue «guardando» un rato tras la desconexión, hasta que llevemos un tiempo sin procesos de emulador.
                if (sock == null)
                {
                    if (Environment.TickCount > _lingerUntil) break;
                    // Si ya no queda ningún emulador, no hace falta seguir guardando
                    if (!AnyEmulatorProcess() && FindEmulator() == IntPtr.Zero) break;
                    Thread.Sleep(120);
                    continue;
                }
                // Short poll: keep the message pump responsive even when no command
                // arrives. Never block for seconds while owning window hooks.
                if (!sock.Poll(50, SelectMode.SelectRead)) continue;
                int n = sock.Receive(buf);
                if (n <= 0)
                {
                    try { sock.Close(); } catch { }
                    sock = null;
                    if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                    break;
                }
                rx.Append(Encoding.UTF8.GetString(buf, 0, n));
                while (true)
                {
                    string all = rx.ToString();
                    int nl = all.IndexOf('\n');
                    if (nl < 0) break;
                    string line = all.Substring(0, nl).Trim();
                    rx.Remove(0, nl + 1);
                    if (line.Length == 0) continue;

                    string cmd = S(line, "cmd");
                    if (cmd == "scope")
                    {
                        // Whitelist of "our" directories. Must arrive before boothide /
                        // embed; the sweeps refuse to touch anything outside it.
                        SetScope(S(line, "dirs"));
                        long appPid = L(line, "pid");
                        _appPid = appPid > 0 ? (uint)appPid : 0;
                        _hostPid = 0;
                        Reply(sock, "{\"ok\":true,\"n\":" + _scopeDirs.Count + "}");
                    }
                    else if (cmd == "embed")
                    {
                        // Volver de ventana independiente a acoplada: primero se limpia la marca de modo independiente y se reactiva la supresión residente,
                        // si no, la ventana del emulador se trataría siempre como «la que el usuario está viendo» y no participaría en Fit.
                        _detachedMode = false;
                        // Acoplar significa «el usuario quiere ver la imagen». La supresión no se desactiva (solo oculta ventanas no acopladas
                        // y ventanas negras de consola), pero antes hay que entregar la ventana desde el estado oculto a SetParent
                        // correctamente, y luego Fit la muestra con SWP_SHOWWINDOW.
                        IntPtr want = new IntPtr(L(line, "host"));
                        uint wantPid = 0;
                        if (want != IntPtr.Zero) GetWindowThreadProcessId(want, out wantPid);
                        // Never re-parent into a foreign window: a stale handle could
                        // point at another app (the exact way "ApkBuddyStart ate WeChat's
                        // window" can happen).
                        if (want == IntPtr.Zero || (_appPid != 0 && wantPid != _appPid))
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"host-not-ours\"}");
                            Thread.Sleep(1);
                        }
                        else
                        {
                            _host = want;
                            _hostPid = wantPid;
                            _chromeRender = FindChromeRender(want);
                            // Las bases de terceros (MuMu etc.) pasan directamente el handle de la ventana de imagen;
                            // "target" es una lista de candidatos separados por comas; se aplica SetParent a cada uno,
                            // y el primero que se convierte de verdad en hijo del anfitrión es el elegido.
                            string targets = S(line, "target");
                            _emu = IntPtr.Zero;
                            if (_quiet) { _quiet = false; _bootHideUntil = 0; }   // No volver a ocultar la ventana que se va a acoplar
                            if (!string.IsNullOrEmpty(targets))
                            {
                                string[] pieces = targets.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                                for (int i = 0; i < pieces.Length; i++)
                                {
                                    IntPtr cand = ParseHwnd(pieces[i]);
                                    if (cand == IntPtr.Zero || !IsWindow(cand)) continue;
                                    // Si ya está acoplada a nuestro anfitrión (embed repetido / cambio de tamaño): se usa directamente
                                    if (GetParent(cand) == want || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                    Embed(_host, cand);
                                    if (GetParent(cand) == _host || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                }
                            }
                            else
                            {
                                _emu = FindEmulator();
                                Embed(_host, _emu);
                            }
                            bool ok = _emu != IntPtr.Zero
                                && (GetParent(_emu) == _host || GetParent(_emu) == _chromeRender);
                            _embedAt = Environment.TickCount;
                            _lastToolSweep = 0;
                            Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), true, (int)L(line, "clipTop"));
                            Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + ",\"emu\":" + _emu.ToInt64() + "}");
                            // Las ventanas de bases de terceros no las creamos nosotros y no se muestran solas:
                            // hay que poner WS_VISIBLE a cada candidato, si no, tras SetParent quedarán ocultas para siempre.
                            if (ok && !string.IsNullOrEmpty(targets)) ShowWindow(_emu, 5);
                        }
                    }
                    else if (cmd == "fit")
                    {
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), false, (int)L(line, "clipTop"));
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "rotate")
                    {
                        Rotate(S(line, "dir"));
                        Thread.Sleep(350);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hide")
                    {
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 0);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "perf")
                    {
                        // El lado JS avisa según priorityMode: en modo game se reducen las pasadas de escaneo de ventanas
                        _perfMode = L(line, "on") != 0;
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "show")
                    {
                        // En modo de ventana independiente, Detach() vacía _emu (lo trata como «fin del acoplamiento»),
                        // así que hay que buscarla otra vez; si no, show/layout actúan sobre un handle vacío
                        // y el síntoma es «al pasar a ventana independiente desaparece la ventana del emulador».
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 5);
                        Reply(sock, "{\"ok\":" + (_emu != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "detach")
                    {
                        // keep=1 significa «pasar a modo de ventana independiente»: no hay que tratarlo como
                        // «fin del acoplamiento, hay que ocultar el emulador», o QuietSweep ocultaría en la
                        // siguiente pasada la ventana que el usuario está viendo.
                        _detachedMode = L(line, "keep") == 1;
                        // El modo independiente puede no haber pasado nunca por embed (_emu sigue siendo 0); primero se busca una vez,
                        // si no, Detach vuelve directamente y show/layout vuelven a actuar sobre un handle vacío.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Detach();
                        Reply(sock, "{\"ok\":true,\"emu\":" + _emu.ToInt64() + "}");
                    }
                    else if (cmd == "title")
                    {
                        // Cambiar el título de la ventana nativa del emulador de "Android Emulator - apkstart:5554"
                        // a un nombre comprensible (por defecto "ApkBuddyStart"). Qt lo restaura al recrear la ventana,
                        // así que QuietSweep lo repone en cada pasada (véase más abajo).
                        string t = S(line, "text");
                        if (t.Length == 0) t = "ApkBuddyStart";
                        _ourTitle = t;
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = _emu != IntPtr.Zero && SetWindowTextW(_emu, t);
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "icon")
                    {
                        // Poner un icono a la ventana nativa del emulador (en modo independiente, la barra de tareas/Alt+Tab muestran el icono de la app actual,
                        // en vez del robot verde por defecto del emulador de Google). Se pasa una ruta absoluta a ICO/PNG.
                        string f = S(line, "file");
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = false;
                        if (f.Length > 0 && System.IO.File.Exists(f))
                        {
                            // Se cachea el handle del icono: al cambiar de app se libera el antiguo y se carga el nuevo; las reposiciones de la inspección usan la caché,
                            // sin volver a LoadImage en cada pasada (eso es E/S de disco y fuga de objetos GDI).
                            if (!String.Equals(f, _ourIconFile, StringComparison.OrdinalIgnoreCase))
                            {
                                if (_ourIconSmall != IntPtr.Zero) DestroyIcon(_ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) DestroyIcon(_ourIconBig);
                                _ourIconSmall = LoadImageW(IntPtr.Zero, f, 1, 32, 32, 0x10);
                                _ourIconBig = LoadImageW(IntPtr.Zero, f, 1, 64, 64, 0x10);
                                if (_ourIconSmall == IntPtr.Zero) _ourIconSmall = _ourIconBig;
                                if (_ourIconBig == IntPtr.Zero) _ourIconBig = _ourIconSmall;
                                _ourIconFile = f;
                            }
                            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero))
                            {
                                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
                                ok = true;
                            }
                        }
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "layout")
                    {
                        // Modo de ventana independiente: la ventana del emulador es nativa del sistema; aquí solo se coloca en el
                        // rectángulo de pantalla indicado (sin SetParent). Orientación/escalado/entrada los gestiona ella misma,
                        // así que no aparecen los problemas del modo acoplado: bordes negros, coordenadas desplazadas, falta de relleno.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu == IntPtr.Zero)
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"no-emu\"}");
                        }
                        else
                        {
                            // Primero se garantiza que es una ventana superior visible (Detach ya le quitó WS_CHILD)
                            ShowWindow(_emu, 5);
                            SetWindowPos(_emu, HWND_TOP,
                                (int)L(line, "x"), (int)L(line, "y"),
                                (int)L(line, "w"), (int)L(line, "h"),
                                SWP_SHOWWINDOW);
                            Reply(sock, "{\"ok\":true}");
                        }
                    }
                    else if (cmd == "hook")
                    {
                        // Options are re-sent on every enable, so changing settings
                        // while the hook is live needs no reinstall / no thread churn.
                        _optRight = L(line, "right") == 1 ? 1 : 0;
                        _optWheel = L(line, "wheel") == 1 ? 1 : 0;
                        _optSide = L(line, "side") == 1 ? 1 : 0;
                        if (L(line, "on") == 1) HookOn(); else HookOff();
                        Reply(sock, "{\"ok\":true,\"hooked\":" + (_hook != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "probe")
                    {
                        IntPtr e = FindEmulator();
                        RECT r = new RECT();
                        if (e != IntPtr.Zero) GetWindowRect(e, out r);
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64()
                            + ",\"x\":" + r.L + ",\"y\":" + r.T
                            + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
                    }
                    else if (cmd == "winready")
                    {
                        // Puerta de listo de bases de terceros: el handle candidato existe + el estado es «existe».
                        // La comprobación de ocultación se hace en el lado JS (véase windowReady en backends/mumu.js).
                        string list = S(line, "target");
                        int alive = 0;
                        string first = "";
                        if (!string.IsNullOrEmpty(list))
                        {
                            string[] pieces = list.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                            for (int i = 0; i < pieces.Length; i++)
                            {
                                IntPtr h = ParseHwnd(pieces[i]);
                                if (h == IntPtr.Zero || !IsWindow(h)) continue;
                                alive++;
                                if (first.Length == 0) first = pieces[i];
                            }
                        }
                        Reply(sock, "{\"ok\":true,\"alive\":" + alive + ",\"first\":\"" + first + "\"}");
                    }
                    else if (cmd == "consoles")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListConsoles() + "]}");
                    }
                    else if (cmd == "windows")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListWindows(L(line, "all") == 1) + "]}");
                    }
                    else if (cmd == "boothide")
                    {
                        if (L(line, "on") == 1)
                        {
                            _quiet = true;
                            _bootHideSweep = 0;
                            _consoleSweep = 0;
                            _bootHideStart = Environment.TickCount;
                            SnapshotConsoles();
                            QuietSweep();
                        }
                        else
                        {
                            // Se conserva la ventana sin cambios y solo se vuelven a ocultar las ventanas negras de consola (apagar quiet suele ser porque
                            // el usuario quiere echar un vistazo a la ventana del emulador; véase startVisible en Ajustes).
                            _quiet = false;
                            HideConsoleWindows();
                        }
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "park")
                    {
                        // La ventana de la app se va a cerrar: primero se desacopla la ventana del emulador del anfitrión y se oculta,
                        // para evitar que al destruir el anfitrión Windows la vuelva a colgar en el escritorio y recupere categoría de superior visible
                        // (de ahí sale el «aparece de la nada una ventana negra de Android Emulator» que ve el usuario).
                        _quiet = true;
                        _bootHideStart = Environment.TickCount;
                        _bootHideSweep = 0;
                        ParkEmulator();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "quit")
                    {
                        Reply(sock, "{\"ok\":true}");
                        run = false;
                        break;
                    }
                    else
                    {
                        Reply(sock, "{\"ok\":false,\"error\":\"unknown\"}");
                    }
                }
            }
            catch (SocketException)
            {
                try { sock.Close(); } catch { }
                sock = null;
                if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                break;
            }
            catch (Exception) { }
        }
        HookOff();
        try { sock.Close(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $src
[ApkAgent]::Serve($Port)
