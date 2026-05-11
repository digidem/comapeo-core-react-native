#!/usr/bin/env bash
set -euo pipefail

# On snapshot restore, sys.boot_completed flips before system_server
# finishes binding settings/package/activity, so the next
# `adb shell settings put` can fail with "Broken pipe". Poll each service
# until it actually answers.

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  # tr -d '\r' because adb echoes CRLF.
  bc=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  if [[ "$bc" == "1" ]] \
     && adb shell 'pm path android' >/dev/null 2>&1 \
     && adb shell 'cmd settings list global' >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "::error::Emulator services did not become ready within 120s" >&2
adb shell getprop 2>/dev/null | grep -E 'boot|svc' >&2 || true
exit 1
