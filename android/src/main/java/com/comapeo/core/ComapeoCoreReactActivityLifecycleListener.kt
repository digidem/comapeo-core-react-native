package com.comapeo.core

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import expo.modules.core.interfaces.ReactActivityLifecycleListener

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
        actionOnService(activity!!, Actions.USER_BACKGROUND)
    }

    private fun actionOnService(activity: Activity, action: Actions) {
        Intent(activity, ComapeoCoreService::class.java).also {
            it.action = action.name
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