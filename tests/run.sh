#!/usr/bin/env bash
# End-to-end smoke tests: drive the real UI in headless Chromium (Playwright)
# through tools/devserver.js against a generated library of sample PDFs.
# Each test prints what it checked; compare with tests/README.md.
#
# usage: tests/run.sh [test ...]      e.g. tests/run.sh measure select-wheel
#   tests: annotate documents save-guard select-wheel measure shapes signature electron
# env:   WORK=<dir>  reuse a working folder (samples are generated once)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export WORK="${WORK:-$(mktemp -d)}"
PORT=5180

if [ ! -d "$WORK/samples" ]; then
  echo "Generating sample PDFs in $WORK/samples"
  python3 "$ROOT/tests/make_samples.py" "$WORK/samples" >/dev/null
  python3 "$ROOT/tests/make_more.py" "$WORK/samples" >/dev/null
fi

node "$ROOT/tools/devserver.js" "$PORT" >"$WORK/devserver.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

tests=("$@")
[ ${#tests[@]} -eq 0 ] && tests=(annotate documents save-guard select-wheel measure shapes signature)
for t in "${tests[@]}"; do
  rm -rf "$WORK/lib" && cp -r "$WORK/samples" "$WORK/lib"
  echo "=== $t"
  if [ "$t" = electron ]; then
    # Needs the Electron binary (node node_modules/electron/install.js) and, on Linux, xvfb-run.
    rm -rf "$WORK/ud" && mkdir -p "$WORK/ud" && printf '{"folder": "%s"}' "$WORK/lib" >"$WORK/ud/config.json"
    xvfb-run -a -s "-screen 0 1440x900x24" node "$ROOT/tests/electron.test.js" 2>&1 | grep -v "dbus\|Gtk\|libva\|ERROR:viz\|gpu_\|ERROR:bus" || true
  else
    node "$ROOT/tests/$t.test.js"
  fi
done
echo "Screenshots and logs are in $WORK"
