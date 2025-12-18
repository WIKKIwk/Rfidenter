package com.st8504.bridge;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public final class BridgeMain {
  private final Object outLock = new Object();

  private Object reader; // com.rfid.trans.UHFLib
  private Object tagCallbackProxy; // com.rfid.trans.TagCallback
  private boolean inventoryStarted = false;

  private Map<String, Object> lastConnectArgs = null;

  public static void main(String[] args) throws Exception {
    new BridgeMain().run();
  }

  private void run() throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = br.readLine()) != null) {
      line = line.trim();
      if (line.isEmpty()) continue;
      handleLine(line);
    }
  }

  private void handleLine(String line) {
    String[] parts = line.split("\t", -1);
    if (parts.length < 3 || !"REQ".equals(parts[0])) {
      sendEvent("LOG", jsonObj("level", "warn", "message", "Bad line: " + line));
      return;
    }
    int id = safeParseInt(parts[1], -1);
    String cmd = parts[2];
    String jsonArgs = parts.length >= 4 ? parts[3] : "{}";

    try {
      Map<String, Object> args = parseFlatJsonObject(jsonArgs);
      Object result = dispatch(cmd, args);
      sendResOk(id, result == null ? "{}" : toJson(result));
    } catch (Exception e) {
      sendResErr(id, e.getMessage() != null ? e.getMessage() : e.toString());
    }
  }

  private Object dispatch(String cmd, Map<String, Object> args) throws Exception {
    if ("STATUS".equals(cmd)) {
      Map<String, Object> st = new HashMap<String, Object>();
      st.put("connected", Boolean.valueOf(reader != null));
      st.put("inventoryStarted", Boolean.valueOf(inventoryStarted));
      st.put("lastConnectArgs", lastConnectArgs == null ? null : lastConnectArgs);
      return st;
    }

    if ("CONNECT".equals(cmd)) {
      String mode = str(args.get("mode"), "tcp").trim().toLowerCase();
      String ip = str(args.get("ip"), "192.168.0.250");
      int port = intv(args.get("port"), 27011);
      String device = str(args.get("device"), "");
      int baud = intv(args.get("baud"), 0);
      int readerType = intv(args.get("readerType"), 16);
      int logSwitch = intv(args.get("logSwitch"), 0);

      String addr;
      int value;
      int connType; // UHFLib/BaseReader: 0=Serial, non-0=TCP
      if ("serial".equals(mode) || "usb".equals(mode) || "rs232".equals(mode)) {
        if (device == null || device.trim().isEmpty()) throw new Exception("Serial device kiritilmagan (masalan: /dev/ttyUSB0)");
        addr = device.trim();
        value = baud;
        connType = 0;
        mode = "serial";
      } else {
        addr = ip;
        value = port;
        connType = 1;
        mode = "tcp";
      }

      disconnectInternal();

      // Enable vendor debug logs only when requested (to avoid flooding the UI).
      try {
        if (logSwitch != 0) System.setProperty("bridge.android.log", "1");
      } catch (Exception ignored) {
      }

      if ("serial".equals(mode)) {
        int[] candidates = buildBaudCandidates(baud);
        int lastRc = -1;
        for (int i = 0; i < candidates.length; i++) {
          int tryBaud = candidates[i];
          Object r = newUHFLib(connType, "ST-8504");
          int rc = -1;
          try {
            rc = intRet(invokeAny(r, "Connect", addr, Integer.valueOf(tryBaud)));
            if (rc == 0) {
              this.reader = r;
              ensureCallback();
              this.lastConnectArgs = new HashMap<String, Object>();
              lastConnectArgs.put("mode", mode);
              lastConnectArgs.put("device", addr);
              lastConnectArgs.put("baud", Integer.valueOf(tryBaud));
              lastConnectArgs.put("readerType", Integer.valueOf(readerType));
              lastConnectArgs.put("logSwitch", Integer.valueOf(logSwitch));
              sendEvent("STATUS", jsonObj("connected", Boolean.TRUE));
              return jsonObj("rc", Integer.valueOf(rc), "baud", Integer.valueOf(tryBaud));
            }
          } finally {
            if (rc != 0) safeInvoke(r, "DisConnect");
          }
          lastRc = rc;
        }
        throw new Exception("Connect failed: " + lastRc);
      }

      Object r = newUHFLib(connType, "ST-8504");
      int rc = -1;
      try {
        rc = intRet(invokeAny(r, "Connect", addr, Integer.valueOf(value)));
        if (rc != 0) throw new Exception("Connect failed: " + rc);
        this.reader = r;
        ensureCallback();
        this.lastConnectArgs = new HashMap<String, Object>();
        lastConnectArgs.put("mode", mode);
        lastConnectArgs.put("ip", addr);
        lastConnectArgs.put("port", Integer.valueOf(value));
        lastConnectArgs.put("readerType", Integer.valueOf(readerType));
        lastConnectArgs.put("logSwitch", Integer.valueOf(logSwitch));
        sendEvent("STATUS", jsonObj("connected", Boolean.TRUE));
        return jsonObj("rc", Integer.valueOf(rc));
      } finally {
        if (rc != 0) safeInvoke(r, "DisConnect");
      }
    }

    if ("DISCONNECT".equals(cmd)) {
      disconnectInternal();
      sendEvent("STATUS", jsonObj("connected", Boolean.FALSE));
      return jsonObj("ok", Boolean.TRUE);
    }

    requireConnected();

    if ("SET_INV_PARAM".equals(cmd)) {
      int ivtType = intv(args.get("ivtType"), 0);
      int memory = intv(args.get("memory"), 1);
      String invPwd = str(args.get("invPwd"), "00000000");
      int qValue = intv(args.get("qValue"), 6);
      int session = intv(args.get("session"), 255);
      int scanTime = intv(args.get("scanTime"), 20);
      int antennaMask = intv(args.get("antennaMask"), 1);
      int tidPtr = intv(args.get("tidPtr"), 0);
      int tidLen = intv(args.get("tidLen"), 0);
      int target = intv(args.get("target"), 0);
      int retryCount = intv(args.get("retryCount"), 0);

      Object rp;
      try {
        rp = invokeAny(reader, "GetInventoryPatameter");
      } catch (Exception ignored) {
        rp = null;
      }
      if (rp == null) rp = newReaderParameter();

      setIntField(rp, "IvtType", ivtType);
      setIntField(rp, "Memory", memory);
      setStringField(rp, "Password", invPwd);
      setIntField(rp, "QValue", qValue);
      setIntField(rp, "Session", session);
      setIntField(rp, "ScanTime", scanTime);
      setIntField(rp, "Target", target);
      setIntField(rp, "reTryCount", retryCount);
      setIntField(rp, "Antenna", antennaMask);
      setIntField(rp, "TidPtr", tidPtr);
      setIntField(rp, "TidLen", tidLen);

      int rc = intRet(invokeAny(reader, "SetInventoryPatameter", rp));
      if (rc != 0) throw new Exception("SetInventoryPatameter failed: " + rc);
      return jsonObj("rc", Integer.valueOf(rc));
    }

    if ("START_READ".equals(cmd)) {
      ensureCallback();
      int rc = intRet(invokeAny(reader, "StartRead"));
      if (rc != 0) {
        inventoryStarted = false;
        sendEvent("STATUS", jsonObj("inventoryStarted", Boolean.FALSE, "rc", Integer.valueOf(rc)));
        throw new Exception("StartRead failed: " + rc);
      }
      inventoryStarted = true;
      sendEvent("STATUS", jsonObj("inventoryStarted", Boolean.TRUE, "rc", Integer.valueOf(rc)));
      return jsonObj("rc", Integer.valueOf(rc));
    }

    if ("STOP_READ".equals(cmd)) {
      safeInvoke(reader, "StopRead");
      inventoryStarted = false;
      sendEvent("STATUS", jsonObj("inventoryStarted", Boolean.FALSE));
      return jsonObj("ok", Boolean.TRUE);
    }

    if ("READ".equals(cmd)) {
      String epc = str(args.get("epc"), "");
      int mem = intv(args.get("mem"), 3);
      int wordPtr = intv(args.get("wordPtr"), 0);
      int num = intv(args.get("num"), 2);
      String password = str(args.get("password"), "00000000");

      byte[] pwd = hexToBytes(password, 4);
      Object out = invokeAny(reader, "ReadDataByEPC", epc, Byte.valueOf((byte) mem), Byte.valueOf((byte) wordPtr), Byte.valueOf((byte) num), pwd);
      if (out == null) return jsonObj("data", null);
      return jsonObj("data", String.valueOf(out));
    }

    if ("WRITE".equals(cmd)) {
      String epc = str(args.get("epc"), "");
      int mem = intv(args.get("mem"), 3);
      int wordPtr = intv(args.get("wordPtr"), 0);
      String password = str(args.get("password"), "00000000");
      String data = str(args.get("data"), "");

      byte[] pwd = hexToBytes(password, 4);
      int rc = intRet(invokeAny(reader, "WriteDataByEPC", epc, Byte.valueOf((byte) mem), Byte.valueOf((byte) wordPtr), pwd, data));
      return jsonObj("rc", Integer.valueOf(rc));
    }

    if ("SET_POWER".equals(cmd)) {
      int power = intv(args.get("power"), 30);
      int rc = intRet(invokeAny(reader, "SetRfPower", Integer.valueOf(power)));
      return jsonObj("rc", Integer.valueOf(rc));
    }

    if ("SET_REGION".equals(cmd)) {
      int band = intv(args.get("band"), 0);
      int maxfre = intv(args.get("maxfre"), 0);
      int minfre = intv(args.get("minfre"), 0);
      int rc = intRet(invokeAny(reader, "SetRegion", Integer.valueOf(band), Integer.valueOf(maxfre), Integer.valueOf(minfre)));
      return jsonObj("rc", Integer.valueOf(rc));
    }

    if ("SET_BEEP".equals(cmd)) {
      int enabled = intv(args.get("enabled"), 1);
      int rc = intRet(invokeAny(reader, "SetBeepNotification", Integer.valueOf(enabled != 0 ? 1 : 0)));
      return jsonObj("rc", Integer.valueOf(rc), "enabled", Integer.valueOf(enabled != 0 ? 1 : 0));
    }

    if ("GET_RETRY".equals(cmd)) {
      byte[] out = new byte[1];
      int rc = intRet(invokeAny(reader, "GetRetryTimes", out));
      int times = out.length > 0 ? (out[0] & 0xFF) : 0;
      return jsonObj("rc", Integer.valueOf(rc), "times", Integer.valueOf(times));
    }

    if ("SET_RETRY".equals(cmd)) {
      int times = intv(args.get("times"), 3);
      int rc = intRet(invokeAny(reader, "SetRetryTimes", Byte.valueOf((byte) times)));
      return jsonObj("rc", Integer.valueOf(rc), "times", Integer.valueOf(times));
    }

    if ("SET_DRM".equals(cmd)) {
      int enabled = intv(args.get("enabled"), 0);
      byte[] in = new byte[] { (byte) (enabled != 0 ? 1 : 0) };
      int rc = intRet(invokeAny(reader, "ConfigDRM", in));
      return jsonObj("rc", Integer.valueOf(rc), "enabled", Integer.valueOf(enabled != 0 ? 1 : 0));
    }

    if ("SET_CHECK_ANT".equals(cmd)) {
      int enabled = intv(args.get("enabled"), 1);
      int rc = intRet(invokeAny(reader, "SetCheckAnt", Byte.valueOf((byte) (enabled != 0 ? 1 : 0))));
      return jsonObj("rc", Integer.valueOf(rc), "enabled", Integer.valueOf(enabled != 0 ? 1 : 0));
    }

    if ("MEASURE_RETURN_LOSS".equals(cmd)) {
      int freqKhz = intv(args.get("freqKhz"), 902750);
      int ant = intv(args.get("ant"), 1); // 1-based for UI
      if (freqKhz <= 0) throw new Exception("freqKhz noto‘g‘ri (masalan: 902750)");

      int antZeroBased = ant <= 0 ? 0 : ant - 1;
      if (antZeroBased > 255) antZeroBased = 255;

      byte[] testFreq = new byte[4];
      testFreq[0] = (byte) ((freqKhz >> 24) & 0xFF);
      testFreq[1] = (byte) ((freqKhz >> 16) & 0xFF);
      testFreq[2] = (byte) ((freqKhz >> 8) & 0xFF);
      testFreq[3] = (byte) (freqKhz & 0xFF);

      byte[] out = new byte[1];
      int rc =
          intRet(
              invokeAny(
                  reader,
                  "MeasureReturnLoss",
                  testFreq,
                  Byte.valueOf((byte) (antZeroBased & 0xFF)),
                  out));

      int rl = out.length > 0 ? (out[0] & 0xFF) : 0;
      return jsonObj(
          "rc",
          Integer.valueOf(rc),
          "freqKhz",
          Integer.valueOf(freqKhz),
          "ant",
          Integer.valueOf(ant),
          "returnLoss",
          Integer.valueOf(rl));
    }

    if ("SET_RELAY".equals(cmd)) {
      int value = intv(args.get("value"), 0);
      int rc = intRet(invokeAny(reader, "SetRelay", Byte.valueOf((byte) value)));
      return jsonObj("rc", Integer.valueOf(rc), "value", Integer.valueOf(value & 0xFF));
    }

    if ("GPIO".equals(cmd)) {
      String op = str(args.get("op"), "get");
      if ("set".equalsIgnoreCase(op)) {
        int value = intv(args.get("value"), 0);
        int rc = intRet(invokeAny(reader, "SetGPIO", Byte.valueOf((byte) value)));
        return jsonObj("rc", Integer.valueOf(rc));
      }
      byte[] outPins = new byte[8];
      int rc = intRet(invokeAny(reader, "GetGPIOStatus", outPins));
      Map<String, Object> resp = new HashMap<String, Object>();
      resp.put("rc", Integer.valueOf(rc));
      resp.put("raw", bytesToHex(outPins));
      return resp;
    }

    if ("GET_INFO".equals(cmd)) {
      byte[] version = new byte[2];
      byte[] readerType = new byte[1];
      byte[] power = new byte[1];
      byte[] band = new byte[1];
      byte[] maxFre = new byte[1];
      byte[] minFre = new byte[1];
      byte[] beep = new byte[1];
      int[] ant = new int[1];

      int rc =
          intRet(
              invokeAny(
                  reader, "GetUHFInformation", version, readerType, power, band, maxFre, minFre, beep, ant));

      int verMajor = version.length > 0 ? (version[0] & 0xFF) : 0;
      int verMinor = version.length > 1 ? (version[1] & 0xFF) : 0;
      int rt = readerType.length > 0 ? (readerType[0] & 0xFF) : 0;

      String fwPrefix;
      if (rt == 0x68) fwPrefix = "UHF2889C6M--";
      else if (rt == 0x76) fwPrefix = "UHF7189M--";
      else if (rt == 0x56) fwPrefix = "UHF5189M--";
      else if (rt == 0x38) fwPrefix = "UHF3189M--";
      else fwPrefix = "UHFREADER288--";

      String fw =
          fwPrefix
              + String.format("%02d", Integer.valueOf(verMajor))
              + "."
              + String.format("%02d", Integer.valueOf(verMinor));

      Map<String, Object> resp = new HashMap<String, Object>();
      resp.put("rc", Integer.valueOf(rc));
      try {
        resp.put("deviceId", String.valueOf(invokeAny(reader, "GetDeviceID")));
      } catch (Exception ignored) {
      }
      resp.put("firmware", fw);
      resp.put("versionMajor", Integer.valueOf(verMajor));
      resp.put("versionMinor", Integer.valueOf(verMinor));
      resp.put("readerType", Integer.valueOf(rt));
      resp.put("readerTypeHex", String.format("%02X", Integer.valueOf(rt)));
      resp.put("powerDbm", Integer.valueOf(power.length > 0 ? (power[0] & 0xFF) : 0));
      resp.put("band", Integer.valueOf(band.length > 0 ? (band[0] & 0xFF) : 0));
      resp.put("minIdx", Integer.valueOf(minFre.length > 0 ? (minFre[0] & 0xFF) : 0));
      resp.put("maxIdx", Integer.valueOf(maxFre.length > 0 ? (maxFre[0] & 0xFF) : 0));
      resp.put("beep", Integer.valueOf(beep.length > 0 ? (beep[0] & 0xFF) : 0));
      resp.put("ant", Integer.valueOf(ant.length > 0 ? ant[0] : 0));

      Map<String, Object> raw = new HashMap<String, Object>();
      raw.put("version", bytesToHex(version));
      raw.put("readerType", bytesToHex(readerType));
      raw.put("power", bytesToHex(power));
      raw.put("band", bytesToHex(band));
      raw.put("maxFre", bytesToHex(maxFre));
      raw.put("minFre", bytesToHex(minFre));
      raw.put("beep", bytesToHex(beep));
      raw.put("ant", ant);
      resp.put("raw", raw);
      return resp;
    }

    throw new Exception("Unknown cmd: " + cmd);
  }

  private void requireConnected() throws Exception {
    if (reader == null) throw new Exception("Not connected");
  }

  private void disconnectInternal() {
    if (reader == null) return;
    try {
      safeInvoke(reader, "StopRead");
    } catch (Exception ignored) {
    }
    try {
      safeInvoke(reader, "DisConnect");
      safeInvoke(reader, "Disconnect");
    } catch (Exception ignored) {
    }
    reader = null;
    tagCallbackProxy = null;
    inventoryStarted = false;
  }

  private Object newUHFLib(int readerType, String tag) throws Exception {
    Class<?> cls = Class.forName("com.rfid.trans.UHFLib");
    return cls.getConstructor(new Class<?>[] { int.class, String.class }).newInstance(new Object[] { Integer.valueOf(readerType), tag });
  }

  private Object newReaderParameter() throws Exception {
    Class<?> cls = Class.forName("com.rfid.trans.ReaderParameter");
    return cls.getConstructor(new Class<?>[] {}).newInstance(new Object[] {});
  }

  private void ensureCallback() throws Exception {
    if (tagCallbackProxy != null) return;
    final Class<?> cbClass = Class.forName("com.rfid.trans.TagCallback");
    InvocationHandler h = (proxy, method, args) -> {
      if ("tagCallback".equals(method.getName()) && args != null && args.length == 1) {
        handleTag(args[0]);
      } else if ("ReadOver".equals(method.getName())) {
        sendEvent("READ_OVER", jsonObj("ok", Boolean.TRUE));
      } else if ("tagCallbackFailed".equals(method.getName()) && args != null && args.length == 1) {
        sendEvent("TAG_FAIL", jsonObj("rc", Integer.valueOf(intv(args[0], 0))));
      }
      return null;
    };
    Object proxy = Proxy.newProxyInstance(cbClass.getClassLoader(), new Class<?>[] { cbClass }, h);
    tagCallbackProxy = proxy;
    invokeAny(reader, "SetCallBack", proxy);
  }

  private void handleTag(Object tag) {
    try {
      String epcId = stringFieldOrGetter(tag, "epcId");
      String memId = stringFieldOrGetter(tag, "memId");
      int rssi = intFieldOrGetter(tag, "rssi");
      int antId = intFieldOrGetter(tag, "antId");
      int phaseBegin = intFieldOrGetter(tag, "phase_begin");
      int phaseEnd = intFieldOrGetter(tag, "phase_end");
      int freqKhz = intFieldOrGetter(tag, "Freqkhz");
      String devName = stringFieldOrGetter(tag, "DevName");
      sendEvent(
          "TAG",
          jsonObj(
              "epcId",
              epcId,
              "memId",
              memId,
              "rssi",
              Integer.valueOf(rssi),
              "antId",
              Integer.valueOf(antId),
              "phaseBegin",
              Integer.valueOf(phaseBegin),
              "phaseEnd",
              Integer.valueOf(phaseEnd),
              "freqKhz",
              Integer.valueOf(freqKhz),
              "devName",
              devName));
    } catch (Exception e) {
      sendEvent("LOG", jsonObj("level", "warn", "message", "Tag parse error: " + e));
    }
  }

  private static void setIntField(Object obj, String name, int value) {
    if (obj == null || name == null) return;
    try {
      Field f = obj.getClass().getField(name);
      if (f.getType() == int.class) f.setInt(obj, value);
      else if (f.getType() == byte.class) f.setByte(obj, (byte) value);
      else f.set(obj, Integer.valueOf(value));
    } catch (Exception ignored) {
    }
  }

  private static void setStringField(Object obj, String name, String value) {
    if (obj == null || name == null) return;
    try {
      Field f = obj.getClass().getField(name);
      if (f.getType() == String.class) f.set(obj, value == null ? "" : value);
      else f.set(obj, String.valueOf(value));
    } catch (Exception ignored) {
    }
  }

  private static String stringFieldOrGetter(Object obj, String name) throws Exception {
    try {
      Field f = obj.getClass().getField(name);
      Object v = f.get(obj);
      return v == null ? "" : String.valueOf(v);
    } catch (NoSuchFieldException ignored) {
    }
    String getter = "get" + Character.toUpperCase(name.charAt(0)) + name.substring(1);
    try {
      Method m = obj.getClass().getMethod(getter, new Class<?>[] {});
      Object v = m.invoke(obj, new Object[] {});
      return v == null ? "" : String.valueOf(v);
    } catch (NoSuchMethodException ignored) {
    }
    return "";
  }

  private static int intFieldOrGetter(Object obj, String name) throws Exception {
    try {
      Field f = obj.getClass().getField(name);
      Object v = f.get(obj);
      return v instanceof Number ? ((Number) v).intValue() : safeParseInt(String.valueOf(v), 0);
    } catch (NoSuchFieldException ignored) {
    }
    String getter = "get" + Character.toUpperCase(name.charAt(0)) + name.substring(1);
    try {
      Method m = obj.getClass().getMethod(getter, new Class<?>[] {});
      Object v = m.invoke(obj, new Object[] {});
      return v instanceof Number ? ((Number) v).intValue() : safeParseInt(String.valueOf(v), 0);
    } catch (NoSuchMethodException ignored) {
    }
    return 0;
  }

  private static Object invokeAny(Object target, String name, Object... args) throws Exception {
    Method[] methods = target.getClass().getMethods();
    for (Method m : methods) {
      if (!m.getName().equals(name)) continue;
      if (m.getParameterTypes().length != args.length) continue;
      Object[] converted = tryConvert(m.getParameterTypes(), args);
      if (converted == null) continue;
      return m.invoke(target, converted);
    }
    throw new NoSuchMethodException(target.getClass().getName() + "." + name);
  }

  private static void safeInvoke(Object target, String name, Object... args) {
    try {
      invokeAny(target, name, args);
    } catch (Exception ignored) {
    }
  }

  private static Object[] tryConvert(Class<?>[] paramTypes, Object[] args) {
    Object[] out = new Object[args.length];
    for (int i = 0; i < args.length; i++) {
      Object v = args[i];
      Class<?> p = paramTypes[i];
      Object cv = convertOne(p, v);
      if (cv == CONVERT_FAIL) return null;
      out[i] = cv;
    }
    return out;
  }

  private static final Object CONVERT_FAIL = new Object();

  private static Object convertOne(Class<?> p, Object v) {
    if (v == null) {
      if (!p.isPrimitive()) return null;
      if (p == boolean.class) return Boolean.FALSE;
      if (p == byte.class) return Byte.valueOf((byte) 0);
      if (p == short.class) return Short.valueOf((short) 0);
      if (p == int.class) return Integer.valueOf(0);
      if (p == long.class) return Long.valueOf(0L);
      if (p == float.class) return Float.valueOf(0f);
      if (p == double.class) return Double.valueOf(0d);
      return CONVERT_FAIL;
    }

    if (p.isInstance(v)) return v;

    if (p == String.class) return String.valueOf(v);

    if (p == int.class || p == Integer.class) {
      if (v instanceof Number) return Integer.valueOf(((Number) v).intValue());
      return Integer.valueOf(safeParseInt(String.valueOf(v), 0));
    }
    if (p == byte.class || p == Byte.class) {
      if (v instanceof Number) return Byte.valueOf(((Number) v).byteValue());
      return Byte.valueOf((byte) safeParseInt(String.valueOf(v), 0));
    }
    if (p == boolean.class || p == Boolean.class) {
      if (v instanceof Boolean) return v;
      String s = String.valueOf(v).trim().toLowerCase();
      return Boolean.valueOf("1".equals(s) || "true".equals(s) || "yes".equals(s));
    }
    if (p == byte[].class && v instanceof byte[]) return v;
    if (p == int[].class && v instanceof int[]) return v;

    return CONVERT_FAIL;
  }

  private static int intRet(Object ret) {
    if (ret == null) return 0;
    if (ret instanceof Number) return ((Number) ret).intValue();
    return safeParseInt(String.valueOf(ret), 0);
  }

  private static int safeParseInt(String s, int def) {
    try {
      return Integer.parseInt(s.trim());
    } catch (Exception e) {
      return def;
    }
  }

  private static int intv(Object v, int def) {
    if (v == null) return def;
    if (v instanceof Number) return ((Number) v).intValue();
    return safeParseInt(String.valueOf(v), def);
  }

  private static String str(Object v, String def) {
    if (v == null) return def;
    return String.valueOf(v);
  }

  // Minimal JSON parsing for flat objects: {"k":"v","n":123}
  // This is ONLY for our local bridge protocol.
  private static Map<String, Object> parseFlatJsonObject(String json) {
    Map<String, Object> out = new HashMap<String, Object>();
    String s = json.trim();
    if (s.isEmpty() || "{}".equals(s)) return out;
    if (s.charAt(0) != '{' || s.charAt(s.length() - 1) != '}') return out;
    s = s.substring(1, s.length() - 1).trim();
    if (s.isEmpty()) return out;
    String[] pairs = s.split(",");
    for (String pair : pairs) {
      int idx = pair.indexOf(':');
      if (idx <= 0) continue;
      String k = unquote(pair.substring(0, idx).trim());
      String raw = pair.substring(idx + 1).trim();
      Object v = parseJsonValue(raw);
      out.put(k, v);
    }
    return out;
  }

  private static Object parseJsonValue(String raw) {
    if (raw.startsWith("\"") && raw.endsWith("\"")) return unquote(raw);
    if ("true".equals(raw)) return Boolean.TRUE;
    if ("false".equals(raw)) return Boolean.FALSE;
    if ("null".equals(raw)) return null;
    try {
      if (raw.contains(".")) return Double.valueOf(Double.parseDouble(raw));
      return Integer.valueOf(Integer.parseInt(raw));
    } catch (Exception ignored) {
    }
    return raw;
  }

  private static String unquote(String s) {
    if (s.startsWith("\"") && s.endsWith("\"") && s.length() >= 2) {
      s = s.substring(1, s.length() - 1);
    }
    return s.replace("\\\"", "\"").replace("\\\\", "\\");
  }

  private void sendResOk(int id, String jsonPayload) {
    sendLine("RES\t" + id + "\tOK\t" + jsonPayload);
  }

  private void sendResErr(int id, String msg) {
    sendLine("RES\t" + id + "\tERR\t" + escapeOneLine(msg));
  }

  private void sendEvent(String evt, String jsonPayload) {
    sendLine("EVT\t" + evt + "\t" + jsonPayload);
  }

  private void sendLine(String line) {
    synchronized (outLock) {
      System.out.print(line);
      System.out.print("\n");
      System.out.flush();
    }
  }

  private static String escapeOneLine(String s) {
    if (s == null) return "";
    return s.replace("\n", " ").replace("\r", " ").replace("\t", " ");
  }

  private static String bytesToHex(byte[] b) {
    StringBuilder sb = new StringBuilder(b.length * 2);
    for (int i = 0; i < b.length; i++) {
      int v = b[i] & 0xFF;
      String h = Integer.toHexString(v).toUpperCase();
      if (h.length() == 1) sb.append('0');
      sb.append(h);
    }
    return sb.toString();
  }

  private static int[] buildBaudCandidates(int preferred) {
    int[] common = new int[] { 57600, 115200, 38400, 19200, 9600, 230400 };
    // Deduplicate while keeping order: preferred first (if >0), then common.
    int[] tmp = new int[1 + common.length];
    int n = 0;
    if (preferred > 0) tmp[n++] = preferred;
    for (int i = 0; i < common.length; i++) {
      int b = common[i];
      boolean seen = false;
      for (int j = 0; j < n; j++) {
        if (tmp[j] == b) {
          seen = true;
          break;
        }
      }
      if (!seen) tmp[n++] = b;
    }
    int[] out = new int[n];
    System.arraycopy(tmp, 0, out, 0, n);
    return out;
  }

  private static byte[] hexToBytes(String hex, int expectedLen) {
    String s = hex == null ? "" : hex.trim();
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.substring(2);
    s = s.replaceAll("[^0-9A-Fa-f]", "");
    if ((s.length() % 2) == 1) s = "0" + s;

    int bytes = s.length() / 2;
    byte[] out = new byte[bytes];
    for (int i = 0; i < bytes; i++) {
      String part = s.substring(i * 2, i * 2 + 2);
      try {
        out[i] = (byte) Integer.parseInt(part, 16);
      } catch (Exception ignored) {
        out[i] = 0;
      }
    }

    if (expectedLen <= 0) return out;
    if (out.length == expectedLen) return out;
    byte[] fixed = new byte[expectedLen];
    int copy = Math.min(expectedLen, out.length);
    System.arraycopy(out, 0, fixed, 0, copy);
    return fixed;
  }

  private static String intArrayToJson(int[] a) {
    if (a == null) return "[]";
    StringBuilder sb = new StringBuilder();
    sb.append('[');
    for (int i = 0; i < a.length; i++) {
      if (i > 0) sb.append(',');
      sb.append(a[i]);
    }
    sb.append(']');
    return sb.toString();
  }

  private static String toJson(Object obj) {
    if (obj == null) return "null";
    if (obj instanceof String) return quoteJson((String) obj);
    if (obj instanceof Number) return String.valueOf(obj);
    if (obj instanceof Boolean) return ((Boolean) obj).booleanValue() ? "true" : "false";
    if (obj instanceof int[]) return intArrayToJson((int[]) obj);
    if (obj instanceof Map) {
      @SuppressWarnings("unchecked")
      Map<String, Object> m = (Map<String, Object>) obj;
      StringBuilder sb = new StringBuilder();
      sb.append('{');
      boolean first = true;
      for (Map.Entry<String, Object> e : m.entrySet()) {
        if (!first) sb.append(',');
        first = false;
        sb.append(quoteJson(e.getKey()));
        sb.append(':');
        sb.append(toJson(e.getValue()));
      }
      sb.append('}');
      return sb.toString();
    }
    return quoteJson(String.valueOf(obj));
  }

  private static String jsonObj(Object... kv) {
    Map<String, Object> m = new HashMap<String, Object>();
    for (int i = 0; i + 1 < kv.length; i += 2) {
      m.put(String.valueOf(kv[i]), kv[i + 1]);
    }
    return toJson(m);
  }

  private static String quoteJson(String s) {
    StringBuilder sb = new StringBuilder();
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '\\' || c == '"') sb.append('\\').append(c);
      else if (c == '\n') sb.append("\\n");
      else if (c == '\r') sb.append("\\r");
      else if (c == '\t') sb.append("\\t");
      else sb.append(c);
    }
    sb.append('"');
    return sb.toString();
  }
}
