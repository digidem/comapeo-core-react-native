import Foundation

/// Tag keys we set on Sentry events. Mirrors `SentryTags.kt` and
/// `src/sentry-tags.ts` so `proc` / `layer` etc. are spelled
/// identically across all three layers.
enum SentryTags {
    static let proc = "proc"
    static let layer = "layer"
    static let phase = "comapeo.phase"
    static let state = "comapeo.state"
    static let source = "source"
    static let timeout = "timeout"
    static let timeoutMs = "timeoutMs"

    // proc values — iOS is single-process, so always "main"
    static let procMain = "main"

    // layer values
    static let layerRn = "rn"
    static let layerNative = "native"
    static let layerNode = "node"
}
