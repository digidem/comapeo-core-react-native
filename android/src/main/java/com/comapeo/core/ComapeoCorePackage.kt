package com.comapeo.core

import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class ComapeoCorePackage : Package {
    override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> {
        log("Creating ReactActivityLifecycleListener")
        return listOf(ComapeoCoreReactActivityLifecycleListener())
    }

    override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> {
        return listOf(ComapeoCoreApplicationLifecycleListener())
    }
}