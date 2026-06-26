## Foreground Service in Android

The NodeJS (which runs CoMapeo Core) is run in a foreground service in a
separate process. This allows it to continue running even when the app is in the
background or killed by the system.

### `dataSync` foreground service type

According to the Android documentation, the
[`dataSync` foreground service type](https://developer.android.com/develop/background-work/services/fgs/service-types#data-sync)
is appropriate for data transfer operations, such as:

- Data upload or download
- Backup-and-restore operations
- Import or export operations
- Fetch data
- Local file processing
- Transfer data between a device and the cloud over a network

### Notification permission (Android 13+)

The foreground service shows an ongoing notification so the user knows the
backend is running. On Android 13 (API level 33) and above, posting any
notification requires the runtime `POST_NOTIFICATIONS` permission. Without it,
the system **suppresses** the service notification, which lets Android
deprioritise the service or kill it sooner under memory pressure. On Android 12
and below (and on iOS) the permission is auto-granted, so there's nothing to
request.

**Who asks: the host app, not this module.** The module _exposes_ the
check/request methods; it never prompts on its own. This keeps the rationale
copy, timing, and the "open settings" fallback under the host app's control
(the settings deep-link UX is tracked in
[#100](https://github.com/digidem/comapeo-core-react-native/issues/100)).
Typically the host calls these around the point where it starts the service —
e.g. on first launch, or just before bringing the app to the foreground.

```ts
import {
  getNotificationPermissionsAsync,
  requestNotificationPermissionsAsync,
} from "@comapeo/core-react-native";

// Check without prompting.
const current = await getNotificationPermissionsAsync();

// Prompt if we still can. `status` is "granted" | "denied" | "undetermined";
// `granted` is a convenience boolean.
if (!current.granted && current.canAskAgain) {
  const result = await requestNotificationPermissionsAsync();
  // result.granted === true  → notification will show
  // result.canAskAgain === false → user picked "Don't ask again";
  //   show your own rationale and deep-link them to app settings.
}
```

Both methods return an expo-style `PermissionResponse`
(`{ status, granted, canAskAgain, expires }`), so the result is
interchangeable with permissions from `expo-camera`, `expo-location`, etc. On
Android < 13 and on iOS they resolve as `granted` without showing a dialog, so
host code can call them unconditionally without branching on platform.

`POST_NOTIFICATIONS` is a single app-global permission, so if your app already
requests it through `expo-notifications` (or any other permissions library)
you don't need these helpers — they exist so you don't have to pull in
`expo-notifications` solely to grant the foreground-service notification.

**Graceful degradation.** Starting the service does **not** require the
permission. If it's missing, the service still starts; it just runs without a
visible notification and may be deprioritised by the system. The service logs
the missing grant (visible in diagnostics) and never crashes on the missing-
permission path. Request the permission to keep the service running reliably in
the background.

### User-initiated stopping

Starting in Android 13 (API level 33), the user can stop an app from the
notification drawer. The system doesn't send any callbacks when the user taps
the Stop button. We could check for the `REASON_USER_REQUESTED` that's part of
the ApplicationExitInfo API.

Test app behavior after the user stops the app:

```bash
adb shell cmd activity stop-app PACKAGE_NAME
```

### Crash recovery and restarting

The embedded Node.js runtime (`node::Start`) is **single-shot per process** — once
it has run in a process it cannot be re-launched there. So on Android "restart the
backend" fundamentally means "kill the `:ComapeoCore` process and cold-start a
fresh one." `ComapeoCoreService` already encodes this: every teardown path ends in
`Process.killProcess(myPid())`.

**There is no in-process restart API, by design.** Recovery is a **re-foreground of
the app**: when the activity resumes, `ComapeoCoreReactActivityLifecycleListener`
fires a `USER_FOREGROUND` intent that cold-starts a fresh FGS process, and the
host-process IPC clients reconnect automatically (`OnActivityEntersForeground` →
`ipc.connect()` / `controlIpc.connect()`). A background→foreground round-trip is
enough; the user does not have to fully kill the app.

**Self-termination on terminal `ERROR`.** To make that recovery path cover *every*
failure, the FGS kills its own process a few seconds after it reaches a terminal
`ERROR` from which the node thread didn't already exit (see
`ComapeoCoreService.onNodeStateChange` / `SELF_TERMINATE_GRACE_MS`). Most errors
already self-resolve (the backend calls `process.exit(1)`, the runtime thread
returns, and the service stops itself); the watchdog is the backstop for the rare
case where the node thread is left alive — e.g. a startup-watchdog timeout whose
`error-native` frame was dropped. Without it, that process would pin itself
indefinitely and the main app process would stay parked at `STARTING` because the
control socket never closes. Converging to a dead process means foregrounding
always recovers, and the JS layer reliably observes `ERROR` (via the control-socket
disconnect) so the host can prompt the user.

Termination is **graceful-first**: it runs the normal `onDestroy` teardown, which
ships the `shutdown` frame and joins the node thread so the backend can close
MapeoManager / SQLite / fastify / sockets and exit on its own (`stopForTeardown`).
That drain is bounded by the 10 s stop timeout; only if node doesn't exit in time
is the process force-killed (`Process.killProcess`). So a self-terminate isn't a
blunt SIGKILL — it gives the runtime a chance to shut down cleanly first.

**The host owns the actual relaunch.** This module deliberately does not relaunch
the app for you. When JS observes `state === "ERROR"` (see
`state.addListener("stateChange", …)`), the host should surface UI that brings the
app back to the foreground. Options:

- **Prompt the user to reopen the app** — the simplest and most robust. On the next
  foreground the FGS cold-starts.
- **Programmatically relaunch** with a module that drives the Android activity
  through `onResume` (or forks a fresh process):
  - [`react-native-restart`](https://github.com/avishayil/react-native-restart) —
    `RNRestart.restart()` recreates the activity, firing `onResume`.
  - A native [ProcessPhoenix](https://github.com/JakeWharton/ProcessPhoenix)-style
    restart (kills and relaunches the process) is the most thorough.

  ⚠️ A **JS-bundle-only reload does not restart the service.** `expo-updates`
  `Updates.reloadAsync()` recreates the React context without an `onPause`→`onResume`
  activity transition, so `USER_FOREGROUND` never fires and the FGS is not
  cold-started. Use it only alongside a real activity/process relaunch.

**Apply backoff in the host.** The native side restarts at most once per
foreground and has no loop protection of its own, so a backend that crashes on
every boot will re-crash on every relaunch. Keep retry policy (exponential backoff,
a max-attempts cap, then a hard-failure screen) in the host app.

**iOS is different.** iOS runs Node.js in-process on a dedicated thread that is
once-per-process and survives background/foreground (it stops only on
`applicationWillTerminate`). A background→foreground round-trip therefore does
**not** restart the backend on iOS — recovery requires a **full app termination and
relaunch** (the user closing and reopening the app, or the OS terminating it). There
is no separate process to self-terminate. Host crash-recovery UI on iOS should ask
the user to fully close and reopen the app.

### Timeout behavior

The system permits `dataSync` foreground services to run for a total of 6 hours
in a 24-hour period, after which the system calls the running service's
`Service.onTimeout(int, int)` method (introduced in Android 15).

If the service does not call `Service.stopSelf()` within a few seconds of when
the system calls `Service.onTimeout(int, int)`, the system throws an internal
exception. The exception is logged in Logcat with the following message:

```
Fatal Exception: android.app.RemoteServiceException: "A foreground service of
type [service type] did not stop within its timeout: [component name]"
```

When the user brings the app to the foreground, the timer resets.

### Testing timeout behavior

Enable timeouts (on a device running Android 15 or higher) by executing the
following command in a terminal:

```bash
adb shell am compat enable FGS_INTRODUCE_TIME_LIMITS PACKAGE_NAME
```

Adjust the timeout period:

```bash
adb shell device_config put activity_manager data_sync_fgs_timeout_duration duration-in-milliseconds
```
