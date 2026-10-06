# SceneCue — écran virtuel (pilote Virtual Display Driver) : liste des sorties, branchement, débranchement.
# Windows PowerShell 5.1, lancé par src/vdisplay.js qui remplace la ligne $Command ci-dessous.
# Même mécanisme que « Étendre / Déconnecter cet écran » dans les paramètres d'affichage : pas besoin de droits administrateur.
# Écrit une ligne JSON.
$Command = @('list')

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class VDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "ChangeDisplaySettingsExW")]
  static extern int ApplyDisplaySettings(IntPtr device, IntPtr dm, IntPtr hwnd, uint flags, IntPtr param);
  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  const int ATTACHED = 0x1, PRIMARY = 0x4;
  const int DM_POSITION = 0x20, DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
  const uint CDS_UPDATEREGISTRY = 0x1, CDS_NORESET = 0x10000000;
  const int ENUM_CURRENT = -1, ENUM_REGISTRY = -2;

  class Output { public string Name, Adapter; public bool Attached, Primary, Virtual; public int X, Y, W, H, Hz; }

  static DEVMODE NewMode() { var m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return m; }

  static List<Output> Outputs() {
    var list = new List<Output>();
    for (uint i = 0; i < 64; i++) {
      var d = new DISPLAY_DEVICE();
      d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      var o = new Output();
      o.Name = d.DeviceName;
      o.Adapter = d.DeviceString;
      o.Attached = (d.StateFlags & ATTACHED) != 0;
      o.Primary = (d.StateFlags & PRIMARY) != 0;
      o.Virtual = d.DeviceString.IndexOf("Virtual Display Driver", StringComparison.OrdinalIgnoreCase) >= 0
        || d.DeviceString.IndexOf("IddSampleDriver", StringComparison.OrdinalIgnoreCase) >= 0;
      var m = NewMode();
      if (o.Attached && EnumDisplaySettings(o.Name, ENUM_CURRENT, ref m)) {
        o.X = m.dmPositionX; o.Y = m.dmPositionY; o.W = m.dmPelsWidth; o.H = m.dmPelsHeight; o.Hz = m.dmDisplayFrequency;
      }
      list.Add(o);
    }
    return list;
  }

  // dans le coin en haut à droite de l'écran le plus à droite : les deux écrans ne se touchent que par un point,
  // la souris ne peut pas glisser dessus par accident
  static void Corner(List<Output> all, Output self, int h, out int x, out int y) {
    Output best = null;
    foreach (var o in all) {
      if (o == self || !o.Attached || o.Virtual || o.W == 0) continue;
      if (best == null || o.X + o.W > best.X + best.W || (o.X + o.W == best.X + best.W && o.Y < best.Y)) best = o;
    }
    x = best == null ? 0 : best.X + best.W;
    y = best == null ? 0 : best.Y - h;
  }

  static bool HasMode(string name, int w, int h, int hz) {
    var m = NewMode();
    for (int i = 0; EnumDisplaySettings(name, i, ref m); i++) {
      if (m.dmPelsWidth == w && m.dmPelsHeight == h && (hz == 0 || m.dmDisplayFrequency == hz)) return true;
    }
    return false;
  }

  static string Q(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  static string B(bool b) { return b ? "true" : "false"; }

  static string Json(List<Output> all) {
    var sb = new StringBuilder("{\"ok\":true,\"outputs\":[");
    for (int i = 0; i < all.Count; i++) {
      var o = all[i];
      int cx, cy;
      Corner(all, o, o.H, out cx, out cy);
      if (i > 0) sb.Append(',');
      sb.Append("{\"name\":" + Q(o.Name) + ",\"adapter\":" + Q(o.Adapter) + ",\"attached\":" + B(o.Attached) + ",\"primary\":" + B(o.Primary)
        + ",\"virtual\":" + B(o.Virtual) + ",\"x\":" + o.X + ",\"y\":" + o.Y + ",\"w\":" + o.W + ",\"h\":" + o.H + ",\"hz\":" + o.Hz
        + ",\"placed\":" + B(o.Attached && o.X == cx && o.Y == cy) + "}");
    }
    return sb.Append("]}").ToString();
  }

  // change le mode d'une sortie (w = h = 0 : la débranche), puis applique
  static string Set(string name, int w, int h, int x, int y, int hz) {
    var m = NewMode();
    m.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT | (hz > 0 ? DM_DISPLAYFREQUENCY : 0);
    m.dmPelsWidth = w; m.dmPelsHeight = h; m.dmPositionX = x; m.dmPositionY = y; m.dmDisplayFrequency = hz;
    int r = ChangeDisplaySettingsEx(name, ref m, IntPtr.Zero, CDS_UPDATEREGISTRY | CDS_NORESET, IntPtr.Zero);
    int a = r == 0 ? ApplyDisplaySettings(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero) : 0;
    return "{\"ok\":" + B(r == 0 && a == 0) + ",\"code\":" + (r != 0 ? r : a) + ",\"w\":" + w + ",\"h\":" + h + ",\"x\":" + x + ",\"y\":" + y + ",\"hz\":" + hz + "}";
  }

  public static string Run(string[] args) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } // coordonnées en vrais pixels
    try {
      var all = Outputs();
      if (args.Length == 0 || args[0] == "list") return Json(all);
      var self = all.Find(o => o.Name == (args.Length > 1 ? args[1] : ""));
      if (self == null) return "{\"ok\":false,\"error\":\"sortie introuvable\"}";
      if (args[0] == "detach") return Set(self.Name, 0, 0, 0, 0, 0);
      if (args[0] == "attach") {
        int w = int.Parse(args[2]), h = int.Parse(args[3]), hz = 60;
        if (!HasMode(self.Name, w, h, hz)) hz = 0;
        if (!HasMode(self.Name, w, h, 0)) {
          // résolution absente du pilote : celle qu'il avait la dernière fois, sinon 1920×1080
          var reg = NewMode();
          if (EnumDisplaySettings(self.Name, ENUM_REGISTRY, ref reg) && reg.dmPelsWidth > 0) { w = reg.dmPelsWidth; h = reg.dmPelsHeight; }
          else { w = 1920; h = 1080; }
        }
        int x, y;
        Corner(all, self, h, out x, out y);
        return Set(self.Name, w, h, x, y, hz);
      }
      return "{\"ok\":false,\"error\":\"commande inconnue\"}";
    } catch (Exception e) {
      return "{\"ok\":false,\"error\":" + Q(e.Message) + "}";
    }
  }
}
'@

[Console]::Out.WriteLine([VDisplay]::Run([string[]]$Command))
