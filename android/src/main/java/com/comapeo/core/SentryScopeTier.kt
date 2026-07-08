package com.comapeo.core

import io.sentry.EventProcessor
import io.sentry.Hint
import io.sentry.SentryBaseEvent
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.protocol.App
import io.sentry.protocol.Device
import io.sentry.protocol.OperatingSystem
import io.sentry.protocol.SentryTransaction

/**
 * Trims the fields sentry-android attaches to every event down to what each
 * privacy tier promises (docs/sentry-integration-plan.md §9b.3 / §9b.4).
 *
 * The diagnostic (default) tier keeps coarse hardware identity plus OS
 * name/version and app id/version/build; the fingerprint-friendly extras
 * (kernel version, `Build.DISPLAY`, app name, locale + timezone, screen
 * metrics) only ship when the user opts into `applicationUsageData`.
 *
 * Contexts are rebuilt from an allowlist rather than nulling a denylist, so a
 * field added by a future SDK version is dropped by default instead of shipped
 * by accident.
 *
 * Error and fatal events are exempt: full device context is most valuable
 * exactly when something crashed, so they keep the SDK's complete device/os/app
 * scope. Only `culture` (locale + timezone), a fingerprint surface with no
 * debugging value, is still dropped from them at the diagnostic tier.
 */
internal class TierScopeEventProcessor(
    private val applicationUsageData: Boolean,
) : EventProcessor {

    override fun process(event: SentryEvent, hint: Hint): SentryEvent {
        if (isError(event)) {
            if (!applicationUsageData) event.contexts.remove("culture")
        } else {
            trimContexts(event)
        }
        return event
    }

    override fun process(transaction: SentryTransaction, hint: Hint): SentryTransaction {
        trimContexts(transaction)
        if (!applicationUsageData && transaction.transaction == "comapeo.boot") {
            slimBootTransaction(transaction)
        }
        return transaction
    }

    /** Error/fatal captures keep the full native scope — see the class doc. */
    private fun isError(event: SentryEvent): Boolean =
        event.level == SentryLevel.ERROR || event.level == SentryLevel.FATAL

    private fun trimContexts(event: SentryBaseEvent) {
        event.contexts.device?.let { event.contexts.setDevice(allowedDevice(it)) }
        event.contexts.operatingSystem?.let {
            event.contexts.setOperatingSystem(allowedOs(it))
        }
        event.contexts.app?.let { event.contexts.setApp(allowedApp(it)) }
        if (!applicationUsageData) {
            // Locale + timezone are high-entropy fingerprint surfaces.
            event.contexts.remove("culture")
        }
    }

    /**
     * §9b.4: boot transactions stay always-on but carry only phase timings at
     * the diagnostic tier — `boot.kind` reveals foreground/background state
     * and span data (e.g. rootkey `generated`) is install-lifecycle shape.
     */
    private fun slimBootTransaction(transaction: SentryTransaction) {
        transaction.removeTag(SentryTags.BOOT_KIND)
        transaction.spans.forEach { it.setData(null) }
    }

    private fun allowedDevice(device: Device): Device = Device().apply {
        manufacturer = device.manufacturer
        brand = device.brand
        model = device.model
        modelId = device.modelId
        family = device.family
        archs = device.archs
        isSimulator = device.isSimulator
        processorCount = device.processorCount
        memorySize = device.memorySize
        storageSize = device.storageSize?.let { bucketStorageSize(it) }
        if (applicationUsageData) {
            screenWidthPixels = device.screenWidthPixels
            screenHeightPixels = device.screenHeightPixels
            screenDensity = device.screenDensity
            screenDpi = device.screenDpi
            timezone = device.timezone
        }
    }

    private fun allowedOs(os: OperatingSystem): OperatingSystem =
        OperatingSystem().apply {
            name = os.name
            version = os.version
            if (applicationUsageData) {
                kernelVersion = os.kernelVersion
                build = os.build
            }
        }

    private fun allowedApp(app: App): App = App().apply {
        appIdentifier = app.appIdentifier
        appVersion = app.appVersion
        appBuild = app.appBuild
        if (applicationUsageData) {
            appName = app.appName
        }
    }

    companion object {
        private const val GB = 1L shl 30

        /** Round up to a standard marketed size (8/16/32/…/1024 GB) so exact
         *  formatted-capacity bytes can't fingerprint a device. Starts at 8 GB
         *  because devices with 8/16 GB of storage are still in the field. */
        internal fun bucketStorageSize(bytes: Long): Long {
            var bucket = 8 * GB
            while (bucket < bytes && bucket < 1024 * GB) bucket = bucket shl 1
            return bucket
        }
    }
}
