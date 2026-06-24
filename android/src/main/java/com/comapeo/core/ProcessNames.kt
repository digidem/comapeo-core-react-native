package com.comapeo.core

import android.content.Context

/**
 * Name of the process this code is running in. Shared by the lifecycle
 * listener (main-or-not gate) and [ComapeoCoreService] (exit-record filter)
 * so the value can never drift from the manifest's `android:process`.
 *
 * Falls back to the package name (the main process) when detection fails;
 * [ComapeoProcessGuard.detectProcessName] is the underlying source.
 */
internal fun currentProcessName(context: Context): String =
    ComapeoProcessGuard.detectProcessName() ?: context.packageName
