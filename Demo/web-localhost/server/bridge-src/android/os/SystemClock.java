package android.os;

public final class SystemClock {
  public static void sleep(long ms) {
    if (ms <= 0) return;
    try {
      Thread.sleep(ms);
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
    }
  }

  public static long uptimeMillis() {
    return java.lang.System.currentTimeMillis();
  }

  public static long elapsedRealtime() {
    return java.lang.System.nanoTime() / 1_000_000L;
  }

  private SystemClock() {}
}

