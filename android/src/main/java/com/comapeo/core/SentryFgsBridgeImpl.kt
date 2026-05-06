package com.comapeo.core

import android.content.Context
import io.sentry.Breadcrumb
import io.sentry.ISpan
import io.sentry.ITransaction
import io.sentry.Sentry
import io.sentry.SentryLevel
import io.sentry.SpanStatus
import io.sentry.TracesSamplingDecision
import io.sentry.TransactionContext
import io.sentry.TransactionOptions
import io.sentry.android.core.SentryAndroid

/**
 * Phase 2b — implementation behind [SentryFgsBridge]. Contains
 * every `io.sentry.*` import in the module's main source set so
 * the public bridge stays free of those references and consumers
 * without sentry-android on the classpath never reach class-load
 * for these symbols.
 *
 * Class-loading rules: the JVM/Dalvik verifier inspects bytecode
 * references at class-load time of the *containing* class, not at
 * verification of the caller. [SentryFgsBridge] references this
 * class via its own bytecode; that reference doesn't trigger
 * loading of [SentryFgsBridgeImpl] until a method on it is
 * actually invoked. The bridge's `Class.forName` probe (in
 * `SentryFgsBridge.isEnabled`) gates every dispatch; when the
 * probe returns `false`, this file is never loaded.
 *
 * All methods are package-internal (`internal`) and assume the
 * bridge has already verified the SDK is present. They throw on
 * pathological misuse (e.g. invalid level strings) — the bridge's
 * outer `try/catch` swallows.
 */
internal object SentryFgsBridgeImpl {

    fun init(context: Context, config: SentryConfig) {
        SentryAndroid.init(context.applicationContext) { options ->
            options.dsn = config.dsn
            options.environment = config.environment
            options.release = config.release
            // Sample rates: defaults match plan §4.5 (errors at 1.0,
            // traces at 0 unless caller configured). The §7.4.2
            // forced-100%-on-boot policy is enforced at span creation
            // (see [startBootTransaction]) rather than at SDK init,
            // so per-tx sampling overrides the global rate cleanly.
            options.sampleRate = config.sampleRate ?: 1.0
            options.tracesSampleRate = config.tracesSampleRate ?: 0.0

            // Process-level tags. Every event from this hub picks
            // these up, so dashboards can split FGS-originated
            // events from main-process ones (which carry
            // `proc:main` from the JS adapter — see src/sentry.ts).
            options.setTag("proc", "fgs")
            options.setTag("layer", "native")
        }
    }

    fun addBreadcrumb(
        category: String,
        message: String,
        level: String,
        data: Map<String, Any?>,
    ) {
        val crumb = Breadcrumb().apply {
            this.category = category
            this.message = message
            this.level = parseLevel(level)
            for ((k, v) in data) {
                if (v != null) setData(k, v)
            }
        }
        Sentry.addBreadcrumb(crumb)
    }

    fun captureException(
        throwable: Throwable,
        tags: Map<String, String>,
    ) {
        Sentry.captureException(throwable) { scope ->
            tags.forEach { (k, v) -> scope.setTag(k, v) }
        }
    }

    fun captureMessage(
        message: String,
        level: String,
        tags: Map<String, String>,
    ) {
        Sentry.captureMessage(message, parseLevel(level)) { scope ->
            tags.forEach { (k, v) -> scope.setTag(k, v) }
        }
    }

    fun startBootTransaction(): Any {
        // Force 100% sample rate per plan §7.4.2 — boot is
        // once-per-process and high value, even when the global
        // tracesSampleRate is low (or 0.0, our default).
        //
        // `TransactionContext` accepts a `TracesSamplingDecision`
        // that overrides the SDK's global decision. Constructing
        // with `(sampled=true, sampleRate=1.0)` keeps the
        // transaction *and* every child span on the wire,
        // regardless of `options.tracesSampleRate`. This is the
        // mechanism the Sentry-Android docs call out for
        // "always-sampled-regardless-of-rate" use cases like app
        // start where the user shouldn't have to crank up their
        // global rate to capture a once-per-process event.
        val context = TransactionContext(
            "comapeo.boot",
            "boot",
            TracesSamplingDecision(true, 1.0),
        )
        val opts = TransactionOptions().apply {
            isBindToScope = true
        }
        return Sentry.startTransaction(context, opts)
    }

    fun startBootSpan(transaction: Any, phase: String): Any {
        require(transaction is ITransaction) {
            "startBootSpan: handle must be ITransaction, got ${transaction.javaClass.name}"
        }
        // Sentry's `startChild` signature is `(operation, description)`
        // — operation is the indexed dashboard column, description is
        // the human-readable label. The plan §7.4.2 names like
        // `boot.rootkey-load` are the operation names; descriptions
        // are short summaries of what each phase actually does.
        //
        // Operation names match the bench backend's `boot.<phase>`
        // taxonomy (apps/benchmark/backend/lib/boot-spans.js on
        // claude/benchmark-uds-rpc-bridge-1Zahz). Keeping the
        // operation names identical means a single Sentry dashboard
        // query can chart both the bench backend's spans and the
        // production FGS-process spans without an alias table.
        val description = when (phase) {
            "rootkey-load" -> "Load 16-byte rootkey from RootKeyStore"
            "init-frame" -> "Send init frame, await ready"
            else -> phase
        }
        return transaction.startChild("boot.$phase", description)
    }

    fun finishSpan(handle: Any, status: String) {
        when (handle) {
            is ITransaction -> {
                handle.status = parseStatus(status)
                handle.finish()
            }
            is ISpan -> {
                handle.status = parseStatus(status)
                handle.finish()
            }
            else -> {
                // Unknown handle type. Likely a test fake or a future
                // SDK addition — silently drop.
            }
        }
    }

    fun resetForTests() {
        // Sentry-Android has no public reset; tests that switch the
        // bridge between configurations re-init via a fresh hub.
        // Nothing to do here; the bridge's own `initialized` flag
        // is reset by `SentryFgsBridge.resetForTests`.
    }

    private fun parseLevel(level: String): SentryLevel = when (level.lowercase()) {
        "fatal" -> SentryLevel.FATAL
        "error" -> SentryLevel.ERROR
        "warning", "warn" -> SentryLevel.WARNING
        "debug" -> SentryLevel.DEBUG
        else -> SentryLevel.INFO
    }

    private fun parseStatus(status: String): SpanStatus = when (status.lowercase()) {
        "ok" -> SpanStatus.OK
        "internal_error", "error" -> SpanStatus.INTERNAL_ERROR
        "deadline_exceeded", "timeout" -> SpanStatus.DEADLINE_EXCEEDED
        "cancelled" -> SpanStatus.CANCELLED
        "not_found" -> SpanStatus.NOT_FOUND
        "unauthenticated" -> SpanStatus.UNAUTHENTICATED
        else -> SpanStatus.UNKNOWN
    }
}
