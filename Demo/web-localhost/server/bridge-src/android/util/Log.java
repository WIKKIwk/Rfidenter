package android.util;

public final class Log {
  private static boolean enabled() {
    String v = System.getenv("BRIDGE_ANDROID_LOG");
    if (v == null) v = System.getProperty("bridge.android.log");
    if (v == null) return false;
    v = v.trim().toLowerCase();
    return "1".equals(v) || "true".equals(v) || "yes".equals(v) || "on".equals(v);
  }

  private static int print(String level, String tag, String msg) {
    if (!enabled()) return 0;
    String out = msg == null ? "" : msg;
    if (out.length() > 900) out = out.substring(0, 900) + "...(truncated)";
    System.err.println("[" + level + "] " + (tag == null ? "" : tag) + ": " + out);
    return 0;
  }

  public static int d(String tag, String msg) {
    return print("D", tag, msg);
  }

  public static int i(String tag, String msg) {
    return print("I", tag, msg);
  }

  public static int w(String tag, String msg) {
    return print("W", tag, msg);
  }

  public static int e(String tag, String msg) {
    return print("E", tag, msg);
  }

  public static int v(String tag, String msg) {
    return print("V", tag, msg);
  }

  private Log() {}
}
