#!/system/bin/sh
# Runs ON THE DEVICE, pushed there by scripts/benchmark-boot.sh. One cold boot
# of the app, with the artefacts left in /data/local/tmp/comapeo-bench for the
# host to pull.
#
#   usage: benchmark-sample.sh <package> <activity> <run-id> <duration-seconds>
#
# Android's shell is mksh with 32-bit arithmetic, so nanosecond epochs must
# never be subtracted here — timestamps are recorded as strings and
# differenced on the host. toybox sed has no `\|` alternation either, so all
# /proc parsing goes through awk.
#
# The per-sample /proc timeline needs to read another process's /proc, which
# only works as root (`adb root` on an emulator). It is optional detail: the
# numbers that matter come from `dumpsys meminfo` and from the backend's own
# `[comapeo.memory] boot` log line, which reads /proc/self and therefore
# needs no privilege at all.

PKG="$1"
ACTIVITY="$2"
RUN="$3"
DUR="${4:-20}"
PROC="$PKG:ComapeoCore"
DIR=/data/local/tmp/comapeo-bench

mkdir -p "$DIR"
LOG="$DIR/$RUN.log"
TL="$DIR/$RUN.timeline"
META="$DIR/$RUN.meta"
MEMINFO="$DIR/$RUN.meminfo"
rm -f "$LOG" "$TL" "$META" "$MEMINFO"

am force-stop "$PKG" >/dev/null 2>&1
# NODE_COMPILE_CACHE lives under cacheDir. Wipe it so every measured boot
# starts from the same state regardless of which build ran last — otherwise
# the first boot after swapping APKs pays for a cache the other build wrote.
rm -rf "/data/data/$PKG/cache/"* 2>/dev/null
sleep 3

logcat -c 2>/dev/null
logcat -v epoch > "$LOG" 2>/dev/null &
LOGPID=$!
sleep 1

T0=$(date +%s.%N)
T0S=$(date +%s)
am start -n "$PKG/$ACTIVITY" >/dev/null 2>&1

# Wait for the backend process to appear.
PID=""
while [ -z "$PID" ]; do
  PID=$(pidof -s "$PROC" 2>/dev/null)
  [ $(( $(date +%s) - T0S )) -ge "$DUR" ] && break
done

if [ -n "$PID" ] && [ -r "/proc/$PID/status" ]; then
  while [ -d "/proc/$PID" ]; do
    [ $(( $(date +%s) - T0S )) -ge "$DUR" ] && break
    awk -v p="$PID" 'BEGIN{
      getline up < "/proc/uptime"; split(up, a, " ");
      f = "/proc/" p "/status";
      while ((getline l < f) > 0) { split(l, kv, ":"); v[kv[1]] = kv[2] + 0 }
      close(f);
      printf "%s %d %d %d %d\n", a[1], v["VmRSS"], v["VmHWM"], v["RssAnon"], v["VmSwap"];
    }'
    sleep 0.05
  done > "$TL"
fi

# Let the backend reach its boot memory sample (backend/index.js schedules it
# 3s after `ready`) before we stop watching.
while [ $(( $(date +%s) - T0S )) -lt "$DUR" ]; do sleep 1; done

[ -n "$PID" ] && dumpsys meminfo "$PID" > "$MEMINFO" 2>/dev/null

{
  echo "run=$RUN"
  echo "t0_epoch=$T0"
  echo "fgs_pid=$PID"
  if [ -n "$PID" ] && [ -d "/proc/$PID" ]; then
    echo "alive=1"
  else
    echo "alive=0"
  fi
} > "$META"

kill "$LOGPID" 2>/dev/null
sleep 1
echo "done $RUN pid=$PID"
