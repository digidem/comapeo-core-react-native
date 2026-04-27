import Foundation
import XCTest

// Mirrors ios/Tests/Helpers/XCTestCase+Polling.swift. The two live in
// separate compilation units — the SPM test target (`ios/Tests/`) and the
// example app's iOS XCTest target (sources copied from here by the
// `with-ios-tests` Expo config plugin) — so they can't share code.

extension XCTestCase {
    /// Polls `condition` until it returns true or `timeout` elapses.
    ///
    /// Prefer this over `Thread.sleep(forTimeInterval:)` + assert for async
    /// state changes. Sleeps are fragile under CI load: a 0.2s sleep "waits
    /// for IPC to connect" most of the time, then flakes when a shared runner
    /// is busy. Polling returns as soon as the condition flips and fails fast
    /// with a clear message when it doesn't.
    ///
    /// The condition is queried synchronously on the calling thread — safe
    /// because the values we poll (`ipc.state`, `service.state`) are
    /// protected by internal locks in the production code.
    ///
    /// - Parameters:
    ///   - timeout: Maximum seconds to wait before failing (default 5).
    ///   - pollInterval: Seconds between polls (default 0.02).
    ///   - message: Autoclosure describing what was expected — shown in
    ///     the failure message.
    ///   - condition: Autoclosure returning true once the condition is met.
    ///   - file / line: Captured for better Xcode navigation on failure.
    func waitUntil(
        timeout: TimeInterval = 5,
        pollInterval: TimeInterval = 0.02,
        _ message: @autoclosure () -> String = "condition was not met in time",
        _ condition: @autoclosure () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            Thread.sleep(forTimeInterval: pollInterval)
        }
        XCTFail(
            "waitUntil timed out after \(timeout)s: \(message())",
            file: file,
            line: line
        )
    }
}
