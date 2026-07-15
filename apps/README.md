# Apps

- `macos/` contains the SwiftPM source for the native germ shell.
- `germ.app` is the generated runnable macOS bundle. Create or refresh it with
  `macos/script/build_and_run.sh --build-only`; it stays out of git because it
  contains machine-specific build output.

The native shell renders the daemon's `/dashboard` route in a `WKWebView`, so
it uses the same HTML, CSS, JavaScript, backend state, and saved sessions as the
browser version.
