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
