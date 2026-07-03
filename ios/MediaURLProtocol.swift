import Foundation

/// Bridges `comapeo://media/...` URL loads onto the backend's UDS-bound HTTP
/// server, streaming the response body straight into the URL loader without
/// buffering the whole payload in memory.
///
/// Registered globally via `URLProtocol.registerClass(_:)` on first
/// `AppLifecycleDelegate` activation. Any `URLSession.shared` request —
/// third-party image libraries, in-app `fetch`-adjacent consumers — picks
/// this up. React Native's `<Image>` does NOT route through here (its
/// `RCTImageLoader` resolves by scheme first); that path is served by
/// `ComapeoMediaImageLoader`.
///
/// **HTTP/1.0 by design.** See `MediaFetcher` — body is EOF-delimited, no
/// chunked decoding.
///
/// **Streaming.** Once the headers are consumed, the protocol enters a
/// read-and-forward loop on a background queue, calling
/// `urlProtocol(_:didLoad:)` per chunk so decoding can start before the full
/// body has arrived and memory stays bounded for large media.
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
        // shutdown(2) under the lock: performRequest's cleanup closes the
        // fd (also under the lock), and the kernel can recycle the fd
        // number the instant close returns — a shutdown after unlock could
        // hit an unrelated socket. shutdown is non-blocking, so holding
        // the lock across it is safe.
        if fd >= 0 {
            // Wake any blocked read in performRequest so the loop exits.
            _ = Darwin.shutdown(fd, SHUT_RDWR)
        }
        stateLock.unlock()
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
            // Close under the lock so stopLoading can never shutdown() an
            // fd number the kernel has already recycled (see stopLoading).
            stateLock.lock()
            if fd >= 0 { close(fd) }
            fd = -1
            stateLock.unlock()
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
        let mimeType = opened.headers["content-type"] ?? "application/octet-stream"
        let length = opened.headers["content-length"].flatMap(Int.init) ?? -1

        let response = URLResponse(
            url: url,
            mimeType: mimeType,
            expectedContentLength: length,
            textEncodingName: nil
        )
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

        // Forward the header tail, then drain the socket chunk by chunk —
        // MediaFetcher.drainBody owns the read loop (and the truncation
        // check against Content-Length at EOF).
        do {
            let completed = try MediaFetcher.drainBody(
                opened,
                isCancelled: { [weak self] in self?.cancelled() ?? true }
            ) { [weak self] chunk in
                guard let self else { return }
                self.client?.urlProtocol(self, didLoad: chunk)
            }
            if completed {
                client?.urlProtocolDidFinishLoading(self)
            }
            // Cancelled: exit silently — the client is gone.
        } catch let error as URLError {
            if !cancelled() { failClient(error) }
        } catch {
            if !cancelled() {
                failClient(.init(.networkConnectionLost,
                                 userInfo: [NSUnderlyingErrorKey: error,
                                            NSLocalizedDescriptionKey:
                                                error.localizedDescription]))
            }
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
