package com.rfid.serialport;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Desktop-compatible replacement for the Android SerialPort class shipped in vendor jars.
 * It configures the tty using `stty` and then opens the device as normal streams.
 */
public final class SerialPort {
  private final FileDescriptor mFd;
  private final FileInputStream mFileInputStream;
  private final FileOutputStream mFileOutputStream;

  public SerialPort(File device, int baudrate, int flags) throws SecurityException, IOException {
    if (device == null) throw new SecurityException("Serial device is null");

    String rawPath = String.valueOf(device.getPath());
    String comName = normalizeComName(rawPath);
    if (!comName.isEmpty()) {
      // Windows COM port support: configure via `mode` and open using the Win32 device path.
      configureWindowsCom(comName, baudrate);
      String openPath = toWindowsComOpenPath(comName);
      FileInputStream in = new FileInputStream(openPath);
      FileOutputStream out = new FileOutputStream(openPath);
      this.mFd = in.getFD();
      this.mFileInputStream = in;
      this.mFileOutputStream = out;
      return;
    }

    if (!device.exists()) throw new IOException("Serial device not found: " + device.getAbsolutePath());

    // Try best-effort tty config; ignore failures (open may still work).
    configureTty(device.getAbsolutePath(), baudrate);

    FileInputStream in = null;
    FileOutputStream out = null;
    try {
      in = new FileInputStream(device);
      out = new FileOutputStream(device);
    } catch (IOException e) {
      String msg = e.getMessage() == null ? "" : e.getMessage().toLowerCase();
      if (msg.contains("permission denied")) {
        throw new IOException(
            "Serial portga ruxsat yo‘q: "
                + device.getAbsolutePath()
                + ". Linux'da odatda `dialout` guruhiga qo‘shish kerak: `sudo usermod -a -G dialout $USER` (so‘ng logout/login).",
            e);
      }
      throw e;
    }

    this.mFd = in.getFD();
    this.mFileInputStream = in;
    this.mFileOutputStream = out;
  }

  public InputStream getInputStream() {
    return mFileInputStream;
  }

  public OutputStream getOutputStream() {
    return mFileOutputStream;
  }

  public void close() {
    try {
      mFileInputStream.close();
    } catch (Exception ignored) {
    }
    try {
      mFileOutputStream.close();
    } catch (Exception ignored) {
    }
  }

  // Kept for binary compatibility with vendor code (some builds call this directly).
  public static FileDescriptor open(String path, int baudrate, int flags) throws IOException {
    String comName = normalizeComName(path);
    String openPath = comName.isEmpty() ? path : toWindowsComOpenPath(comName);
    FileInputStream in = new FileInputStream(openPath);
    return in.getFD();
  }

  private static boolean isWindows() {
    String os = String.valueOf(System.getProperty("os.name", "")).toLowerCase();
    return os.contains("win");
  }

  private static String normalizeComName(String rawPath) {
    if (!isWindows()) return "";
    if (rawPath == null) return "";
    String p = rawPath.trim();
    if (p.isEmpty()) return "";

    // If something like "C:\...\COM3" gets passed, take the last segment.
    String normalized = p.replace('\\', '/');
    String last = normalized.substring(normalized.lastIndexOf('/') + 1);
    if (last.matches("(?i)^COM\\d+$")) p = last;

    if (p.matches("(?i)^COM\\d+$")) return p.toUpperCase();
    if (p.matches("(?i)^\\\\\\\\\\.\\\\COM\\d+$")) return p.substring(4).toUpperCase(); // "\\.\COM3" -> "COM3"
    return "";
  }

  private static String toWindowsComOpenPath(String comName) {
    return "\\\\.\\" + String.valueOf(comName).trim().toUpperCase();
  }

  private static void configureTty(String devicePath, int baudrate) {
    if (devicePath == null || devicePath.isEmpty()) return;
    if (baudrate <= 0) return;

    String os = String.valueOf(System.getProperty("os.name", "")).toLowerCase();
    boolean isMac = os.contains("mac");
    String flag = isMac ? "-f" : "-F";

    List<String> cmd = new ArrayList<String>();
    cmd.add("stty");
    cmd.add(flag);
    cmd.add(devicePath);
    cmd.add(String.valueOf(baudrate));
    cmd.add("raw");
    cmd.add("-echo");

    try {
      Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
      try {
        p.waitFor();
      } catch (InterruptedException ignored) {
        Thread.currentThread().interrupt();
      }
    } catch (Exception ignored) {
      // Best-effort only.
    }
  }

  private static void configureWindowsCom(String comName, int baudrate) {
    if (!isWindows()) return;
    if (comName == null || comName.isEmpty()) return;
    if (baudrate <= 0) return;

    List<String> cmd = new ArrayList<String>();
    cmd.add("cmd");
    cmd.add("/c");
    cmd.add("mode");
    cmd.add(comName + ":");
    cmd.add("BAUD=" + baudrate);
    cmd.add("PARITY=N");
    cmd.add("DATA=8");
    cmd.add("STOP=1");

    try {
      Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
      try {
        p.waitFor();
      } catch (InterruptedException ignored) {
        Thread.currentThread().interrupt();
      }
    } catch (Exception ignored) {
      // Best-effort only.
    }
  }
}
