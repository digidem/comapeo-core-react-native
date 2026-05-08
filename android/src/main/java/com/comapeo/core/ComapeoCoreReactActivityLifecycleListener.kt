package com.comapeo.core

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** Intent extra key for the boot-tracing `serviceStartTimeMs` stamp. */
const val EXTRA_SERVICE_START_ELAPSED_MS = "com.comapeo.core.serviceStartElapsedMs"

class ComapeoCoreReactActivityLifecycleListener : ReactActivityLifecycleListener {

    override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
        super.onCreate(activity, savedInstanceState)
        log("onCreate")
//        actionOnService(activity!!, Actions.USER_FOREGROUND)
    }

    override fun onResume(activity: Activity) {
        super.onResume(activity)
        log("onResume")
        actionOnService(activity, Actions.USER_FOREGROUND)
    }

    override fun onPause(activity: Activity?) {
        super.onPause(activity)
        log("onPause")
        activity?.let { actionOnService(it, Actions.USER_BACKGROUND) }
    }

    private fun actionOnService(activity: Activity, action: Actions) {
        Intent(activity, ComapeoCoreService::class.java).also {
            it.action = action.name
            // elapsedRealtime is monotonic across processes (it counts
            // wall time including deep sleep). The FGS reads it in
            // onStartCommand and uses the delta to backdate the
            // boot.fgs-launch span.
            it.putExtra(EXTRA_SERVICE_START_ELAPSED_MS, SystemClock.elapsedRealtime())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                log("Starting the service in >=26 Mode")
                activity.startForegroundService(it)
                return
            }
            log("Starting the service in < 26 Mode")
            activity.startService(it)
        }
    }
}