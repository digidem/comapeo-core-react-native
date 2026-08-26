#!/system/bin/sh
# Runs ON THE DEVICE, pushed there by scripts/benchmark-boot.sh. One cold boot
# of the app, with the artefacts left in /data/local/tmp/comapeo-bench for the
# host to pull.
#
#   usage: benchmark-sample.sh <package> <activity> <run-id> <duration-seconds>
#
# Android's shell is mksh with 32-bit arithmetic, so nanosecond epochs must
# never be subtracted here — timestamps are recorded as strings and
# differenced on the host.

PKG="$1"
ACTIVITY="$2"
RUN="$3"
DUR="${4:-20}"
PROC="$PKG:ComapeoCore"
DIR=/data/local/tmp/comapeo-bench

mkdir -p "$DIR"
LOG="$DIR/$RUN.log"
META="$DIR/$RUN.meta"
rm -f "$LOG" "$META"

am force-stop "$PKG" >/dev/null 2>&1
# NODE_COMPILE_CACHE lives under cacheDir. Wipe it so every measured boot
# starts from the same state regardless of which build ran last. Only works
# when this shell is root; the host warns when it is not.
rm -rf "/data/data/$PKG/cache/"* 2>/dev/null
sleep 3

logcat -c 2>/dev/null
# Everything the collector parses is a `[comapeo.*]` line. The backend's tag
# (Comapeo:NodeJS) contains a colon, which a tag:priority filterspec cannot
# express, so filter on the message instead of capturing the whole device log.
logcat -v epoch -e '\[comapeo\.' > "$LOG" 2>/dev/null &
LOGPID=$!
sleep 1

T0=$(date +%s.%N)
# Older toybox date leaves %N unexpanded; fall back to whole seconds.
case "$T0" in
  *N*) T0=$(date +%s); T0_PRECISION=s ;;
  *)   T0_PRECISION=ns ;;
esac
T0S=$(date +%s)
am start -n "$PKG/$ACTIVITY" >/dev/null 2>&1

# Wait for the backend process to appear.
PID=""
while [ -z "$PID" ]; do
  PID=$(pidof -s "$PROC" 2>/dev/null)
  [ $(( $(date +%s) - T0S )) -ge "$DUR" ] && break
  sleep 0.05
done

# Let the backend reach its boot memory sample (backend/index.js schedules it
# 3s after `ready`) before we stop watching.
while [ $(( $(date +%s) - T0S )) -lt "$DUR" ]; do sleep 1; done

{
  echo "run=$RUN"
  echo "t0_epoch=$T0"
  echo "t0_precision=$T0_PRECISION"
  echo "fgs_pid=$PID"
} > "$META"

kill "$LOGPID" 2>/dev/null
sleep 1
echo "done $RUN pid=$PID"
