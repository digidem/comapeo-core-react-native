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
