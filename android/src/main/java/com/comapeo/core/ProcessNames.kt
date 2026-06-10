package com.comapeo.core

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process

/**
 * Name of the process this code is running in. Shared by the lifecycle
 * listener (main-or-not gate) and [ComapeoCoreService] (exit-record filter)
 * so the value can never drift from the manifest's `android:process`.
 *
 * The pre-28 fallback is a binder IPC — call off the main thread.
 */
internal fun currentProcessName(context: Context): String =
    if (Build.VERSION.SDK_INT >= 28) {
        Application.getProcessName()
    } else {
        val pid = Process.myPid()
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        am.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName
            ?: context.packageName
    }
