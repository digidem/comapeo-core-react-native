import Foundation

/// Shared UDS-fetch implementation for `comapeo://media/...` URLs.
///
/// Two consumers:
///
///   1. `MediaURLProtocol` (streaming) — registered globally via
///      `URLProtocol.registerClass(_:)` so any `URLSession.shared`-backed
///      caller (share sheet, third-party libraries) gets the body chunked
///      into the URL loader without buffering.
///
///   2. `ComapeoMediaImageLoader` (Obj-C `RCTImageURLLoader`) — required for
///      React Native's built-in `<Image>`. RN's `RCTImageLoader` looks up
///      a registered `RCTImageURLLoader` by scheme **before** ever
///      touching `URLSession`, so a `URLProtocol` alone gives
///      "No suitable image URL loader found for comapeo://...". The
///      loader buffers the whole body into `NSData` (it must, to call
///      `[UIImage imageWithData:]`) and decodes a `UIImage` for the
///      completion handler.
///
/// Both call into the same `connect → write request → parse headers →
/// drain body` pipeline; the only difference is whether the body is
/// streamed in chunks or accumulated in a `Data`.
///
/// **HTTP/1.0 by design.** Forces Fastify into "Connection: close, body
/// delimited by EOF" mode so neither code path needs a chunked-encoding
/// state machine. Trade-off is no keep-alive, fine for our request volume.
@objc(ComapeoMediaFetcher)
public final class MediaFetcher: NSObject {
    /// Source for the path the backend's Fastify HTTP server is bound to.
    /// `AppLifecycleDelegate` installs the closure pointing at
    /// `NodeJSService.mediaSocketPath` once the service is constructed.
    /// `nil` → backend not booted yet; callers see a clear error instead of
    /// a hang.
    public static var socketPathProvider: (() -> String?)?

    public static let scheme = "comapeo"
    public static let host = "media"

    /// Connection-attempt budget. Image loads happen most often as part of
    /// a list scroll; if the backend isn't up after ~10 s of retry,
    /// hanging the request further would only make the UI worse.
    static let connectMaxRetries = 5

    /// `true` if `request.url` matches the scheme this fetcher handles.
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

    /// Synchronous variant. Throws the underlying `URLError` (or a wrapped
    /// `NSError`) on any failure.
    public static func fetchSync(url: URL) throws -> Data {
        let opened = try open(url: url)
        defer { close(opened.fd) }

        guard (200..<300).contains(opened.status) else {
            throw URLError(
                .fileDoesNotExist,
                userInfo: [NSLocalizedDescriptionKey:
                    "HTTP \(opened.status) for \(url.path)"]
            )
        }

        var body = opened.bodyTail
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = Darwin.read(opened.fd, &buffer, buffer.count)
            if n > 0 {
                body.append(buffer, count: n)
                continue
            }
            if n == 0 { return body }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                var pfd = pollfd(fd: opened.fd, events: Int16(POLLIN), revents: 0)
                _ = Darwin.poll(&pfd, 1, 5000)
                continue
            }
            throw URLError(.networkConnectionLost,
                           userInfo: [NSLocalizedDescriptionKey: "read errno \(errno)"])
        }
    }

    /// Connects the UDS, writes the HTTP/1.0 request, parses the status
    /// line + headers, and returns an open fd positioned at the first
    /// body byte plus any tail bytes that landed in the same read.
    /// Closing `fd` is the caller's responsibility.
    static func open(url: URL) throws -> OpenedResponse {
        guard let socketPath = socketPathProvider?() else {
            throw URLError(.cannotConnectToHost,
                           userInfo: [NSLocalizedDescriptionKey:
                                        "Media socket path not configured"])
        }

        let pathAndQuery = (url.path.isEmpty ? "/" : url.path)
            + (url.query.map { "?\($0)" } ?? "")

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

    struct OpenedResponse {
        let fd: Int32
        let status: Int
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
        // Split on CRLF; tolerate bare LF for safety.
        let lines = raw.split(whereSeparator: { $0 == "\r" || $0 == "\n" })
            .map { String($0) }
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

    static func mimeFromExtension(_ ext: String) -> String? {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "heic": return "image/heic"
        default: return nil
        }
    }
}
