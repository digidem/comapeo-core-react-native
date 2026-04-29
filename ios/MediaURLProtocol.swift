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
    private let workQueue = DispatchQueue(label: "com.comapeo.core.media.url-protocol")
    private var fd: Int32 = -1
    private let stateLock = NSLock()
    private var isCancelled = false

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        return MediaFetcher.canHandle(url)
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

        let opened: MediaFetcher.OpenedResponse
        do {
            opened = try MediaFetcher.open(url: url)
        } catch let error as URLError {
            failClient(error)
            return
        } catch {
            failClient(.init(.cannotConnectToHost,
                             userInfo: [NSUnderlyingErrorKey: error,
                                        NSLocalizedDescriptionKey: error.localizedDescription]))
            return
        }

        stateLock.lock()
        // Honour stopLoading() that arrived during MediaFetcher.open().
        guard !isCancelled else {
            stateLock.unlock()
            close(opened.fd)
            return
        }
        fd = opened.fd
        stateLock.unlock()

        defer {
            stateLock.lock()
            let toClose = fd
            fd = -1
            stateLock.unlock()
            if toClose >= 0 { close(toClose) }
        }

        guard (200..<300).contains(opened.status) else {
            failClient(.init(.fileDoesNotExist,
                             userInfo: [NSLocalizedDescriptionKey:
                                            "HTTP \(opened.status) for \(url.path)"]))
            return
        }

        // Build a URLResponse — image loaders only look at MIME type and
        // (when present) expectedContentLength, so we don't round-trip
        // every header.
        let mimeType = opened.headers["content-type"]
            ?? MediaFetcher.mimeFromExtension(url.pathExtension)
            ?? "application/octet-stream"
        let length = opened.headers["content-length"].flatMap(Int.init) ?? -1

        let response = URLResponse(
            url: url,
            mimeType: mimeType,
            expectedContentLength: length,
            textEncodingName: nil
        )
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

        // Flush any body bytes that came in with the headers' final read,
        // then drain the socket to EOF chunk by chunk.
        if !opened.bodyTail.isEmpty {
            client?.urlProtocol(self, didLoad: opened.bodyTail)
        }

        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while !cancelled() {
            let n = Darwin.read(opened.fd, &buffer, buffer.count)
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
                var pfd = pollfd(fd: opened.fd, events: Int16(POLLIN), revents: 0)
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
}
