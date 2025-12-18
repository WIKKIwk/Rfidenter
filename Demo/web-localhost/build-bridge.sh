#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

ECJ_VERSION="3.37.0"
TOOLS_DIR="$ROOT_DIR/tools"
ECJ_JAR="$TOOLS_DIR/ecj-$ECJ_VERSION.jar"
FAKE_JDK_DIR="$TOOLS_DIR/fake-jdk"

SRC_DIR="$ROOT_DIR/server/bridge-src"
OUT_DIR="$ROOT_DIR/server/bridge-out"

mkdir -p "$TOOLS_DIR" "$OUT_DIR"

if [[ ! -f "$ECJ_JAR" ]]; then
  echo "Downloading ECJ compiler (one-time)..."
  curl -fsSL "https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/$ECJ_VERSION/ecj-$ECJ_VERSION.jar" -o "$ECJ_JAR"
fi

JAVA_HOME_DETECTED="$(java -XshowSettings:properties -version 2>&1 | sed -n 's/ *java.home = //p' | head -n 1)"
JAVA_VERSION_DETECTED="$(java -version 2>&1 | head -n 1 | sed -n 's/.*\"\\(.*\\)\".*/\\1/p')"

# Some distros ship a JRE without a top-level "release" file; ECJ expects it.
# Create a minimal fake JDK home that points to the real "lib/modules".
mkdir -p "$FAKE_JDK_DIR"
if [[ ! -e "$FAKE_JDK_DIR/lib" ]]; then
  ln -s "$JAVA_HOME_DETECTED/lib" "$FAKE_JDK_DIR/lib"
fi
cat > "$FAKE_JDK_DIR/release" <<EOF
JAVA_VERSION="$JAVA_VERSION_DETECTED"
OS_NAME="Linux"
OS_ARCH="amd64"
EOF

echo "Compiling Java bridge..."
rm -rf "$OUT_DIR"/*

mapfile -d '' -t JAVA_SOURCES < <(find "$SRC_DIR" -type f -name '*.java' -print0)

java -jar "$ECJ_JAR" \
  --system "$FAKE_JDK_DIR" \
  -proc:none \
  -d "$OUT_DIR" \
  -8 \
  "${JAVA_SOURCES[@]}"

echo "OK: $OUT_DIR"
