#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="germ"
EXECUTABLE_NAME="germ-macos"
BUNDLE_ID="org.sonicfield.germ"
MIN_SYSTEM_VERSION="13.0"
MARKETING_VERSION="0.3.2"
BUNDLE_VERSION="5"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Keep the runnable bundle where repository users expect to find apps. The
# Swift sources remain in apps/macos; the generated bundle is apps/germ.app.
APPS_DIR="$(cd "$ROOT_DIR/.." && pwd)"
APP_BUNDLE="$APPS_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$EXECUTABLE_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
ICON_SRC="$ROOT_DIR/Resources/AppIcon.icns"

cd "$ROOT_DIR"

export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT_DIR/.build/clang-module-cache}"
mkdir -p "$CLANG_MODULE_CACHE_PATH"

pkill -x "$EXECUTABLE_NAME" >/dev/null 2>&1 || true
for _ in {1..20}; do
  pgrep -x "$EXECUTABLE_NAME" >/dev/null || break
  sleep 0.1
done

if [ ! -f "$ICON_SRC" ]; then
  echo "Generating AppIcon.icns…"
  python3 "$ROOT_DIR/script/make_icon.py"
fi

swift build
BUILD_BINARY="$(swift build --show-bin-path)/$EXECUTABLE_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"
cp "$ICON_SRC" "$APP_RESOURCES/AppIcon.icns"

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleShortVersionString</key>
  <string>$MARKETING_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUNDLE_VERSION</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>germ records hardware input only when you start a Record module in the Chamber.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>germ captures shared system audio only when you start an Audio Snapshot module and choose a source.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# Bind the generated Info.plist and resources into a coherent local bundle.
/usr/bin/codesign --force --deep --sign - "$APP_BUNDLE"

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --build-only|build)
    echo "Built $APP_BUNDLE"
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$EXECUTABLE_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\" OR process == \"$EXECUTABLE_NAME\""
    ;;
  --verify|verify)
    open_app
    for _ in {1..90}; do
      if ! pgrep -x "$EXECUTABLE_NAME" >/dev/null; then
        echo "$APP_NAME exited before the dashboard became ready" >&2
        exit 1
      fi
      if curl --fail --silent --show-error --max-time 2 \
        "http://127.0.0.1:5178/health" >/dev/null 2>&1 && \
        curl --fail --silent --show-error --max-time 2 \
        "http://127.0.0.1:5178/dashboard" >/dev/null 2>&1; then
        echo "Verified $APP_BUNDLE and http://127.0.0.1:5178/dashboard"
        exit 0
      fi
      sleep 0.5
    done
    echo "$APP_NAME is running, but its dashboard did not become ready within 45 seconds" >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [run|--build-only|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
