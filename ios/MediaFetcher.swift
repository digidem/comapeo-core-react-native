import Foundation

/// Shared UDS-fetch implementation for `comapeo://media/...` URLs.
///
/// The backend's blob/icon HTTP server binds to a Unix domain socket
/// (`media.sock`) inside the app sandbox — never a TCP port — so no other
/// app on the device can read media. `@comapeo/core` returns *relative*
/// paths (`/blobs/...`); `src/mediaUrl.ts` composes them into
/// `comapeo://media/...` URLs which resolve here.
///
/// Three consumers:
///
///   1. `MediaURLProtocol` (streaming) — registered globally via
///      `URLProtocol.registerClass(_:)` so any `URLSession.shared`-backed
///      caller gets the body chunked into the URL loader without buffering.
///
///   2. `ComapeoMediaImageLoader` (Obj-C `RCTImageURLLoader`) — required for
///      React Native's built-in `<Image>`. RN's `RCTImageLoader` looks up a
///      registered `RCTImageURLLoader` by scheme **before** ever touching
///      `URLSession`, so a `URLProtocol` alone gives "No suitable image URL
///      loader found for comapeo://...". The loader buffers the whole body
///      (it must, to call `UIImage(data:)`).
///
///   3. `ComapeoCoreModule.getShareableMediaUrl` — snapshots a body to a
///      cache file (`fetchToFile`) so it can cross the process boundary via
///      the share sheet. `comapeo://` URLs can't: this `URLProtocol` only
///      exists inside this process.
///
/// **HTTP/1.0 by design.** Forces Fastify into "Connection: close, body
/// delimited by EOF" mode so no code path needs a chunked-encoding state
/// machine. Trade-off is no keep-alive — fine, every request opens a fresh
/// UDS connection anyway.
@objc(ComapeoMediaFetcher)
public final class MediaFetcher: NSObject {
    /// Source for the path the backend's media server is bound to.
    /// `AppLifecycleDelegate` installs the closure pointing at
    /// `NodeJSService.mediaSocketPath` once the service is constructed.
    /// `nil` → backend not booted yet; callers see a clear error instead of
    /// a hang.
    public static var socketPathProvider: (() -> String?)?

    public static let scheme = "comapeo"
    public static let host = "media"

    /// Connection-attempt budget: 8 attempts with 100 ms → 5 s exponential
    /// backoff ≈ 11 s of retry. Long enough to cover a cold boot that is
    /// still running DB migrations (image loads can legitimately race it —
    /// a failed load is terminal for RN's image pipeline, which won't
    /// re-fetch a failed URI); bounded so a dead backend surfaces as an
    /// error rather than a permanent hang. `var` so connect-failure tests
    /// can shrink the budget instead of sleeping through it.
    static var connectMaxRetries = 8

    /// `true` if `url` matches the scheme+host this fetcher handles.
    @objc public static func canHandle(_ url: URL) -> Bool {
        return url.scheme?.lowercased() == scheme && url.host?.lowercased() == host
    }

    /// Buffered fetch — drives the whole pipeline, returning the body as a
    /// single `Data`. Used by the Obj-C `RCTImageURLLoader` (which has to
    /// hand `UIImage` a `Data` anyway). For streaming, see
    /// `MediaURLProtocol`.
    ///
    /// `completion` is invoked on a background queue.
    @objc(fetchURL:completion:)
    public static func fetch(
        url: NSURL,
        completion: @escaping (Data?, NSError?) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let data = try fetchSync(url: url as URL)
                completion(data, nil)
            } catch let error as NSError {
                completion(nil, error)
            }
        }
    }

    /// Synchronous buffered fetch. Throws a `URLError` on any failure
    /// (including non-2xx statuses).
    public static func fetchSync(url: URL) throws -> Data {
        let opened = try open(url: url)
        defer { close(opened.fd) }
        try throwUnlessOk(opened, url: url)

        var body = Data()
        try drainBody(opened) { chunk in body.append(chunk) }
        return body
    }

    /// Fetches `url` and snapshots the body to a file in `directory`,
    /// returning the file URL. The filename is a digest-prefix of the media
    /// path plus an extension derived from the served Content-Type (blob
    /// names carry no extension, and share-sheet targets key previews and
    /// handlers off it). Backs the module's `getShareableMediaUrl`.
    public static func fetchToFile(url: URL, directory: URL) throws -> URL {
        let opened = try open(url: url)
        defer { close(opened.fd) }
        try throwUnlessOk(opened, url: url)

        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
        pruneStaleSnapshots(in: directory)

        // Digest-prefix the name (over path AND query — icon URLs differ
        // only by query params): the final path segment (the blob name) is
        // shared across variants of one blob (original/preview/thumbnail),
        // so it alone would collide.
        let digest = pathDigestHex(rawPathAndQuery(url)).prefix(16)
        let base = url.lastPathComponent.isEmpty ? "media" : url.lastPathComponent
        let ext = extensionForMimeType(opened.headers["content-type"])
            .map { ".\($0)" } ?? ""
        let fileUrl = directory.appendingPathComponent("\(digest)-\(base)\(ext)")

        // Stream into a temp file, then rename into place atomically, so a
        // share target still reading a previous snapshot never observes a
        // truncated file, and a failed fetch never leaves a partial one.
        let tempUrl = directory.appendingPathComponent(
            ".\(UUID().uuidString).tmp")
        FileManager.default.createFile(atPath: tempUrl.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tempUrl)
        do {
            try drainBody(opened) { chunk in
                try handle.write(contentsOf: chunk)
            }
            try handle.close()
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: tempUrl)
            throw error
        }
        // rename(2) semantics: replaces any existing snapshot atomically;
        // an open fd on the old inode keeps reading the old bytes.
        if rename(tempUrl.path, fileUrl.path) != 0 {
            try? FileManager.default.removeItem(at: tempUrl)
            throw URLError(.cannotWriteToFile,
                           userInfo: [NSLocalizedDescriptionKey:
                                        "rename errno \(errno)"])
        }
        return fileUrl
    }

    /// Best-effort removal of snapshots older than `maxAge`, run before
    /// each new snapshot so the share cache can't grow without bound (the
    /// docs tell callers to request a fresh URL per share, so old copies
    /// are dead weight). Errors are ignored — pruning must never fail a
    /// share. 24h is comfortably longer than any share target needs the
    /// file.
    static func pruneStaleSnapshots(
        in directory: URL,
        maxAge: TimeInterval = 24 * 60 * 60
    ) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let cutoff = Date(timeIntervalSinceNow: -maxAge)
        for entry in entries {
            let values = try? entry.resourceValues(
                forKeys: [.contentModificationDateKey])
            if let mtime = values?.contentModificationDate, mtime < cutoff {
                try? fm.removeItem(at: entry)
            }
        }
    }

    private static func throwUnlessOk(_ opened: OpenedResponse, url: URL) throws {
        guard (200..<300).contains(opened.status) else {
            throw URLError(
                .fileDoesNotExist,
                userInfo: [NSLocalizedDescriptionKey:
                    "HTTP \(opened.status) for \(url.path)"]
            )
        }
    }

    /// Drains an opened response to EOF, invoking `onChunk` for the header
    /// tail and then every socket read. The single copy of the read loop's
    /// errno handling, shared by `fetchSync`, `fetchToFile`, and
    /// `MediaURLProtocol`.
    ///
    /// HTTP/1.0 bodies are EOF-delimited, so a peer dying mid-response is
    /// indistinguishable from completion at the socket layer — when the
    /// response carried a `Content-Length` (Fastify always sends one), the
    /// byte count is verified at EOF and a short body throws instead of
    /// passing truncated media off as complete.
    ///
    /// `isCancelled` is polled between reads; when it flips, the drain
    /// stops without error and returns `false` (the caller arranged the
    /// wakeup by shutting the socket down). Returns `true` on a complete
    /// body.
    @discardableResult
    static func drainBody(
        _ opened: OpenedResponse,
        isCancelled: () -> Bool = { false },
        onChunk: (Data) throws -> Void
    ) throws -> Bool {
        let expected = opened.headers["content-length"].flatMap(Int.init)
        var received = 0

        if !opened.bodyTail.isEmpty {
            received += opened.bodyTail.count
            try onChunk(opened.bodyTail)
        }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while !isCancelled() {
            let n = Darwin.read(opened.fd, &buffer, buffer.count)
            if n > 0 {
                received += n
                try onChunk(Data(buffer[0..<n]))
                continue
            }
            if n == 0 {
                if let expected, received != expected {
                    throw URLError(
                        .networkConnectionLost,
                        userInfo: [NSLocalizedDescriptionKey:
                            "Truncated body: \(received) of \(expected) bytes"])
                }
                return true
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                var pfd = pollfd(fd: opened.fd, events: Int16(POLLIN), revents: 0)
                _ = Darwin.poll(&pfd, 1, 5000)
                continue
            }
            throw URLError(.networkConnectionLost,
                           userInfo: [NSLocalizedDescriptionKey: "read errno \(errno)"])
        }
        return false
    }

    /// Connects the UDS, writes the HTTP/1.0 request, parses the status
    /// line + headers, and returns an open fd positioned at the first body
    /// byte plus any tail bytes that landed in the same read. Closing `fd`
    /// is the caller's responsibility.
    static func open(url: URL) throws -> OpenedResponse {
        guard let socketPath = socketPathProvider?() else {
            throw URLError(.cannotConnectToHost,
                           userInfo: [NSLocalizedDescriptionKey:
                                        "Media socket path not configured"])
        }

        let pathAndQuery = rawPathAndQuery(url)

        let fd: Int32
        do {
            fd = try connectWithRetry(socketPath: socketPath,
                                      maxRetries: connectMaxRetries)
        } catch {
            throw URLError(.cannotConnectToHost,
                           userInfo: [NSUnderlyingErrorKey: error,
                                      NSLocalizedDescriptionKey:
                                        error.localizedDescription])
        }

        do {
            let httpRequest =
                "GET \(pathAndQuery) HTTP/1.0\r\n"
                + "Host: localhost\r\n"
                + "Connection: close\r\n"
                + "\r\n"
            guard let bytes = httpRequest.data(using: .ascii) else {
                throw URLError(.badURL)
            }
            try writeAll(fd: fd, data: bytes)
            let headers = try readHeaders(fd: fd)
            return OpenedResponse(
                fd: fd,
                status: headers.status,
                headers: headers.headers,
                bodyTail: headers.bodyTail
            )
        } catch {
            close(fd)
            throw error
        }
    }

    /// Path + query exactly as they appear in the URL (percent-encoding
    /// preserved). `URL.path` percent-DECODES, which would diverge from
    /// what the server routes on (and from Android's `uri.encodedPath`).
    static func rawPathAndQuery(_ url: URL) -> String {
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let rawPath = comps?.percentEncodedPath ?? url.path
        let rawQuery = comps?.percentEncodedQuery ?? url.query
        return (rawPath.isEmpty ? "/" : rawPath)
            + (rawQuery.map { "?\($0)" } ?? "")
    }

    struct OpenedResponse {
        let fd: Int32
        let status: Int
        /// Header names lower-cased.
        let headers: [String: String]
        /// Body bytes that landed in the same read as the end-of-headers
        /// marker. Caller must consume these before continuing to read fd.
        let bodyTail: Data
    }

    private struct HeaderParseResult {
        let status: Int
        let headers: [String: String]
        let bodyTail: Data
    }

    /// Loops `write(2)` until all bytes are sent. Handles `EINTR` and
    /// `EAGAIN`/`EWOULDBLOCK` (the latter via `poll`).
    private static func writeAll(fd: Int32, data: Data) throws {
        try data.withUnsafeBytes { (rawBuf: UnsafeRawBufferPointer) in
            guard let base = rawBuf.baseAddress else {
                throw URLError(.badURL)
            }
            var written = 0
            while written < data.count {
                let n = Darwin.write(fd, base.advanced(by: written),
                                     data.count - written)
                if n > 0 { written += n; continue }
                if n < 0 {
                    if errno == EINTR { continue }
                    if errno == EAGAIN || errno == EWOULDBLOCK {
                        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                        _ = Darwin.poll(&pfd, 1, 5000)
                        continue
                    }
                    throw URLError(.networkConnectionLost,
                                   userInfo: [NSLocalizedDescriptionKey:
                                                "write errno \(errno)"])
                }
                // n == 0 → peer closed.
                throw URLError(.networkConnectionLost)
            }
        }
    }

    /// Reads bytes from `fd` until the CRLFCRLF that ends the header
    /// section, parses status line + headers, returns any body bytes that
    /// landed in the same read.
    private static func readHeaders(fd: Int32) throws -> HeaderParseResult {
        var buf = Data()
        let chunk = 4096
        var scratch = [UInt8](repeating: 0, count: chunk)
        let terminator: [UInt8] = [0x0d, 0x0a, 0x0d, 0x0a] // \r\n\r\n
        let maxHeaderBytes = 64 * 1024

        while true {
            // Bound-check: a runaway server should not be able to make us
            // allocate megabytes of header.
            if buf.count > maxHeaderBytes {
                throw URLError(.badServerResponse,
                               userInfo: [NSLocalizedDescriptionKey:
                                            "Header section too large"])
            }
            let n = Darwin.read(fd, &scratch, chunk)
            if n > 0 {
                buf.append(scratch, count: n)
                if let endIndex = findTerminator(in: buf, terminator: terminator) {
                    let headerData = buf[..<endIndex]
                    let bodyTail = buf[(endIndex + terminator.count)...]
                    let parsed = try parseHeaders(headerData: Data(headerData))
                    return HeaderParseResult(
                        status: parsed.0,
                        headers: parsed.1,
                        bodyTail: Data(bodyTail)
                    )
                }
                continue
            }
            if n == 0 {
                throw URLError(.badServerResponse,
                               userInfo: [NSLocalizedDescriptionKey:
                                            "EOF before end of headers"])
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                _ = Darwin.poll(&pfd, 1, 5000)
                continue
            }
            throw URLError(.networkConnectionLost,
                           userInfo: [NSLocalizedDescriptionKey: "read errno \(errno)"])
        }
    }

    private static func findTerminator(in data: Data, terminator: [UInt8]) -> Int? {
        guard data.count >= terminator.count else { return nil }
        return data.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) -> Int? in
            let bytes = ptr.bindMemory(to: UInt8.self)
            outer: for i in 0...(data.count - terminator.count) {
                for j in 0..<terminator.count {
                    if bytes[i + j] != terminator[j] { continue outer }
                }
                return i
            }
            return nil
        }
    }

    private static func parseHeaders(headerData: Data) throws -> (Int, [String: String]) {
        guard let raw = String(data: headerData, encoding: .isoLatin1) else {
            throw URLError(.badServerResponse,
                           userInfo: [NSLocalizedDescriptionKey:
                                        "Header bytes not parseable"])
        }
        // Split on CRLF; tolerate bare LF for safety. Operate on unicode
        // scalars, not Characters: Swift folds a "\r\n" pair into a single
        // grapheme-cluster Character, so a Character-level split never sees
        // the line breaks and returns the whole block as one line.
        let lines = raw.unicodeScalars
            .split(whereSeparator: { $0 == "\r" || $0 == "\n" })
            .map { String(String.UnicodeScalarView($0)) }
            .filter { !$0.isEmpty }
        guard let statusLine = lines.first else {
            throw URLError(.badServerResponse,
                           userInfo: [NSLocalizedDescriptionKey: "Empty header section"])
        }
        let parts = statusLine.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2, let status = Int(parts[1]) else {
            throw URLError(.badServerResponse,
                           userInfo: [NSLocalizedDescriptionKey:
                                        "Malformed status line: \(statusLine)"])
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        return (status, headers)
    }

    /// File extension for a served `Content-Type`, or nil when unknown.
    /// Must stay byte-identical to the Android mapping in
    /// `MediaHttpClient.kt`.
    static func extensionForMimeType(_ mimeType: String?) -> String? {
        guard let mimeType else { return nil }
        // Strip any "; charset=..." parameter.
        let bare = mimeType.split(separator: ";", maxSplits: 1)[0]
            .trimmingCharacters(in: .whitespaces).lowercased()
        switch bare {
        case "image/jpeg": return "jpg"
        case "image/png": return "png"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/svg+xml": return "svg"
        case "image/heic": return "heic"
        case "video/mp4": return "mp4"
        case "video/quicktime": return "mov"
        case "audio/mpeg": return "mp3"
        case "audio/mp4": return "m4a"
        case "audio/aac": return "aac"
        case "audio/wav", "audio/x-wav": return "wav"
        case "application/pdf": return "pdf"
        default: return nil
        }
    }

    private static func pathDigestHex(_ input: String) -> String {
        // Filename de-collision only, not security: two FNV-1a 64-bit
        // passes (forward + reversed input) in plain Swift, so the macOS
        // swift-test target needs no CryptoKit/CommonCrypto import.
        var hash1: UInt64 = 0xcbf29ce484222325
        for byte in input.utf8 {
            hash1 ^= UInt64(byte)
            hash1 = hash1 &* 0x100000001b3
        }
        var hash2: UInt64 = 0x84222325cbf29ce4
        for byte in input.utf8.reversed() {
            hash2 ^= UInt64(byte)
            hash2 = hash2 &* 0x100000001b3
        }
        return String(format: "%016llx%016llx", hash1, hash2)
    }
}
