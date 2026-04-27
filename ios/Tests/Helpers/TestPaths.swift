import Foundation

/// Helpers for managing short-path temporary directories in tests.
///
/// `sockaddr_un.sun_path` is 104 bytes on Darwin. `NSTemporaryDirectory()` on
/// iOS/macOS returns a long path (e.g. `/var/folders/.../T/`) that — once a
/// UUID and a socket filename are appended — frequently exceeds the limit.
/// The kernel silently truncates the path, which surfaces as `bind()` failing
/// with `EADDRINUSE` or `connect()` hanging on a nonexistent socket.
///
/// All IPC tests use these helpers to get a guaranteed-short directory under
/// `/tmp/`, and route the reasoning through one place instead of duplicating
/// the comment (and the workaround) in every `setUp`.
enum TestPaths {
    /// Returns a unique short-path directory under `/tmp`. Caller is responsible
    /// for cleaning it up, typically with `removeTempDir` in `tearDown`.
    /// - Parameter prefix: 3-4 char prefix so test suites are distinguishable
    ///   when poking around `/tmp/` during debugging (e.g. `cmt`, `cms`, `cml`).
    static func makeShortTempDir(prefix: String) -> String {
        let shortID = UUID().uuidString.prefix(8)
        let path = "/tmp/\(prefix)-\(shortID)"
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    static func removeTempDir(_ path: String?) {
        guard let path = path else { return }
        try? FileManager.default.removeItem(atPath: path)
    }
}
