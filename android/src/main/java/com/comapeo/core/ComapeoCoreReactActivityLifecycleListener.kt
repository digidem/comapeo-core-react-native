package com.comapeo.core

import android.app.Activity
import android.os.Bundle
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** Intent extra key for the boot-tracing `serviceStartTimeMs` stamp. */
const val EXTRA_SERVICE_START_ELAPSED_MS = "com.comapeo.core.serviceStartElapsedMs"

class ComapeoCoreReactActivityLifecycleListener : ReactActivityLifecycleListener {

    override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
        super.onCreate(activity, savedInstanceState)
        log("onCreate")
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
        ComapeoCoreService.sendWithPersistedContent(activity, action)
    }
}