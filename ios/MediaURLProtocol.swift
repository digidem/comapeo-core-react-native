import Foundation

/// Bridges `comapeo://media/...` URL loads onto the backend's UDS-bound HTTP
/// server, streaming the response body straight into the URL loader without
/// buffering the whole image in memory.
///
/// Registered globally via `URLProtocol.registerClass(_:)` at app launch
/// (see `AppLifecycleDelegate.applicationDidFinishLaunching`). Any
/// `URLSession.shared` request — including the one React Native's image
/// loader uses for non-`http` schemes — picks this up and routes it here.
///
/// **HTTP/1.0 by design.** The request line uses `HTTP/1.0` so Fastify's
/// response is forced into "Connection: close, body delimited by EOF" mode.
/// That sidesteps `Transfer-Encoding: chunked` and `Content-Length`-based
/// framing, leaving only headers + raw body to parse — a much smaller
/// surface than implementing chunked decoding inside this protocol.
///
/// **Streaming.** Once the headers are consumed, the protocol enters a
/// read-and-forward loop on a background queue, calling
/// `urlProtocol(_:didLoad:)` for each chunk so the URL loader / image
/// decoder can begin decoding before the full body has arrived. That keeps
/// memory bounded for large images regardless of source-side framing.
///
/// **Cancellation.** `stopLoading()` flips `isCancelled` and shuts the
/// socket down; the loop notices on the next read and exits without
/// emitting a completion or error to the now-dead client.
class MediaURLProtocol: URLProtocol {
    /// Source for the path the backend's Fastify HTTP server is bound to.
    /// `AppLifecycleDelegate` installs the closure pointing at
    /// `NodeJSService.mediaSocketPath` once the service is constructed.
    /// A nil value means we haven't booted yet — clients see a clear error
    /// instead of a hang.
    static var mediaSocketPathProvider: (() -> String?)?

    static let scheme = "comapeo"
    static let host = "media"

    /// Connection-attempt budget. Image loads happen most often as part of a
    /// list scroll; if the backend isn't up after ~10 s of retry, hanging
    /// the request further would only make the UI worse.
    private static let connectMaxRetries = 5

    private let workQueue = DispatchQueue(label: "com.comapeo.core.media.url-protocol")
    private var fd: Int32 = -1
    private let stateLock = NSLock()
    private var isCancelled = false

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        return url.scheme?.lowercased() == scheme && url.host?.lowercased() == host
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        workQueue.async { [weak self] in
            self?.performRequest()
        }
    }

    override func stopLoading() {
        stateLock.lock()
        isCancelled = true
        let fdSnapshot = fd
        stateLock.unlock()
        if fdSnapshot >= 0 {
            // Wake any blocked read in performRequest so the loop exits.
            _ = Darwin.shutdown(fdSnapshot, SHUT_RDWR)
        }
    }

    private func performRequest() {
        guard let url = request.url else {
            failClient(.init(.badURL))
            return
        }

        guard let socketPath = MediaURLProtocol.mediaSocketPathProvider?() else {
            failClient(.init(.cannotConnectToHost,
                             userInfo: [NSLocalizedDescriptionKey: "Media socket path not configured"]))
            return
        }

        let pathAndQuery = (url.path.isEmpty ? "/" : url.path)
            + (url.query.map { "?\($0)" } ?? "")

        let connectedFd: Int32
        do {
            connectedFd = try connectWithRetry(
                socketPath: socketPath,
                maxRetries: MediaURLProtocol.connectMaxRetries
            )
        } catch {
            failClient(.init(.cannotConnectToHost,
                             userInfo: [NSUnderlyingErrorKey: error,
                                        NSLocalizedDescriptionKey: error.localizedDescription]))
            return
        }

        stateLock.lock()
        // Honour stopLoading() that arrived during connectWithRetry.
        guard !isCancelled else {
            stateLock.unlock()
            close(connectedFd)
            return
        }
        fd = connectedFd
        stateLock.unlock()

        defer {
            stateLock.lock()
            let toClose = fd
            fd = -1
            stateLock.unlock()
            if toClose >= 0 { close(toClose) }
        }

        let httpRequest =
            "GET \(pathAndQuery) HTTP/1.0\r\n"
            + "Host: localhost\r\n"
            + "Connection: close\r\n"
            + "\r\n"
        guard let requestBytes = httpRequest.data(using: .ascii) else {
            failClient(.init(.badURL))
            return
        }

        if !writeAll(connectedFd, data: requestBytes) {
            if !cancelled() {
                failClient(.init(.networkConnectionLost))
            }
            return
        }

        let headerResult: HeaderParseResult
        do {
            headerResult = try readHeaders(fd: connectedFd)
        } catch {
            if !cancelled() {
                failClient(.init(.badServerResponse,
                                 userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]))
            }
            return
        }

        guard (200..<300).contains(headerResult.status) else {
            failClient(.init(.fileDoesNotExist,
                             userInfo: [NSLocalizedDescriptionKey:
                                            "HTTP \(headerResult.status) for \(pathAndQuery)"]))
            return
        }

        // Build a fake URLResponse — image loaders only look at MIME type
        // and (when present) expectedContentLength, so we don't need to
        // round-trip every header.
        let mimeType = headerResult.headers["content-type"]
            ?? mimeFromExtension(url.pathExtension)
            ?? "application/octet-stream"
        let length = headerResult.headers["content-length"].flatMap(Int.init) ?? -1

        let response = URLResponse(
            url: url,
            mimeType: mimeType,
            expectedContentLength: length,
            textEncodingName: nil
        )
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

        // Flush any over-read body bytes from the header-parsing buffer first,
        // then drain the socket to EOF.
        if !headerResult.bodyTail.isEmpty {
            client?.urlProtocol(self, didLoad: headerResult.bodyTail)
        }

        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while !cancelled() {
            let n = Darwin.read(connectedFd, &buffer, buffer.count)
            if n > 0 {
                client?.urlProtocol(self, didLoad: Data(buffer[0..<n]))
                continue
            }
            if n == 0 {
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                var pfd = pollfd(fd: connectedFd, events: Int16(POLLIN), revents: 0)
                _ = Darwin.poll(&pfd, 1, 5000)
                continue
            }
            if !cancelled() {
                failClient(.init(.networkConnectionLost,
                                 userInfo: [NSLocalizedDescriptionKey: "read errno \(errno)"]))
            }
            return
        }
    }

    private func cancelled() -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return isCancelled
    }

    private func failClient(_ error: URLError) {
        client?.urlProtocol(self, didFailWithError: error)
    }

    private func writeAll(_ fd: Int32, data: Data) -> Bool {
        return data.withUnsafeBytes { rawBuf -> Bool in
            guard let base = rawBuf.baseAddress else { return false }
            var written = 0
            while written < data.count {
                let n = Darwin.write(fd, base.advanced(by: written), data.count - written)
                if n > 0 { written += n; continue }
                if n < 0 {
                    if errno == EINTR { continue }
                    if errno == EAGAIN || errno == EWOULDBLOCK {
                        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                        _ = Darwin.poll(&pfd, 1, 5000)
                        continue
                    }
                    return false
                }
                return false
            }
            return true
        }
    }

    private struct HeaderParseResult {
        let status: Int
        let headers: [String: String]
        /// Body bytes that were over-read while looking for the end-of-headers
        /// marker. Must be flushed to the URL loader before draining the socket.
        let bodyTail: Data
    }

    /// Reads bytes from `fd` until the end of the HTTP header section
    /// (CRLF CRLF), then parses status + headers. Any body bytes that
    /// landed in the same read are returned as `bodyTail`.
    private func readHeaders(fd: Int32) throws -> HeaderParseResult {
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
                               userInfo: [NSLocalizedDescriptionKey: "Header section too large"])
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
                               userInfo: [NSLocalizedDescriptionKey: "EOF before end of headers"])
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

    private func findTerminator(in data: Data, terminator: [UInt8]) -> Int? {
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

    private func parseHeaders(headerData: Data) throws -> (Int, [String: String]) {
        guard let raw = String(data: headerData, encoding: .isoLatin1) else {
            throw URLError(.badServerResponse,
                           userInfo: [NSLocalizedDescriptionKey: "Header bytes not parseable"])
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
                           userInfo: [NSLocalizedDescriptionKey: "Malformed status line: \(statusLine)"])
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

    private func mimeFromExtension(_ ext: String) -> String? {
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
