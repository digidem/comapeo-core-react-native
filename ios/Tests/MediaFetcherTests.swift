import XCTest
@testable import ComapeoCore

/// Exercises the media fetch pipeline the way its consumers do — a URL in,
/// bytes (or an error) out — against a fake backend speaking HTTP/1.0 over a
/// Unix domain socket, exactly the wire contract of the real Node.js media
/// server (`fastify.listen({ path })` + `Connection: close`, body delimited
/// by EOF). No implementation details of the fetcher are inspected.
final class MediaFetcherTests: XCTestCase {
    private var tempDir: String!
    private var server: MockNodeServer!
    private var acceptThread: Thread?

    /// Requests the fake server received (request line only), in order.
    private let requestLines = NSMutableArray()

    private var savedRetries = MediaFetcher.connectMaxRetries

    override func setUp() {
        super.setUp()
        tempDir = TestPaths.makeShortTempDir(prefix: "cmm")
        let socketPath = (tempDir as NSString).appendingPathComponent("media.sock")
        server = MockNodeServer(socketPath: socketPath)
        MediaFetcher.socketPathProvider = { socketPath }
        // Shrink the connect budget so connect-failure tests fail in
        // ~300ms instead of sleeping through the production ~11s backoff.
        savedRetries = MediaFetcher.connectMaxRetries
        MediaFetcher.connectMaxRetries = 2
    }

    override func tearDown() {
        MediaFetcher.connectMaxRetries = savedRetries
        MediaFetcher.socketPathProvider = nil
        server.stop()
        TestPaths.removeTempDir(tempDir)
        super.tearDown()
    }

    // MARK: - Fake HTTP/1.0 media server

    /// Starts an accept loop that answers every connection with `status`,
    /// the given headers, and `body` — written in chunks to prove the
    /// client reassembles a body that spans multiple reads — then closes
    /// the connection (HTTP/1.0 end-of-body).
    private func startFakeMediaServer(
        status: String = "200 OK",
        headers: [String: String] = [:],
        body: Data,
        chunkSize: Int = 64 * 1024,
        contentLengthOverride: Int? = nil
    ) throws {
        try server.start()
        let serverRef = server!
        let lines = requestLines
        let thread = Thread {
            while true {
                let fd = serverRef.acceptClient()
                if fd < 0 { return } // server closed
                defer { close(fd) }

                // Read until end-of-request-headers, capture request line.
                var request = Data()
                var buf = [UInt8](repeating: 0, count: 4096)
                while !request.contains(sequence: [0x0d, 0x0a, 0x0d, 0x0a]) {
                    let n = Darwin.read(fd, &buf, buf.count)
                    if n <= 0 { break }
                    request.append(buf, count: n)
                }
                if let head = String(data: request, encoding: .ascii),
                   let line = head.components(separatedBy: "\r\n").first {
                    lines.add(line)
                }

                var head = "HTTP/1.0 \(status)\r\n"
                for (key, value) in headers {
                    head += "\(key): \(value)\r\n"
                }
                head += "Content-Length: \(contentLengthOverride ?? body.count)\r\n\r\n"
                _ = head.data(using: .ascii)!.withUnsafeBytes {
                    Darwin.write(fd, $0.baseAddress, $0.count)
                }
                var offset = 0
                while offset < body.count {
                    let end = min(offset + chunkSize, body.count)
                    let wrote = body.subdata(in: offset..<end).withUnsafeBytes {
                        Darwin.write(fd, $0.baseAddress, $0.count)
                    }
                    if wrote <= 0 { break }
                    offset += wrote
                }
                // close(fd) via defer marks end-of-body.
            }
        }
        thread.start()
        acceptThread = thread
    }

    private func mediaURL(_ path: String) -> URL {
        URL(string: "comapeo://media\(path)")!
    }

    // MARK: - Tests

    func testFetchReturnsServedBytes() throws {
        // > 1 MiB so the body necessarily spans many socket reads.
        var payload = Data(count: 1_200_000)
        payload.withUnsafeMutableBytes { buf in
            for i in 0..<buf.count { buf[i] = UInt8((i &* 31) & 0xff) }
        }
        try startFakeMediaServer(headers: ["Content-Type": "image/png"], body: payload)

        let path = "/blobs/proj/drive/photo/original/00aabbccddeeff11"
        let data = try MediaFetcher.fetchSync(url: mediaURL(path))

        XCTAssertEqual(data, payload)
        XCTAssertEqual(requestLines.firstObject as? String, "GET \(path) HTTP/1.0")
    }

    func testFetchPreservesQueryParameters() throws {
        try startFakeMediaServer(body: Data([0x1]))

        let path = "/icons/proj/abcdef/small.png?pixelDensity=2"
        _ = try MediaFetcher.fetchSync(url: mediaURL(path))

        XCTAssertEqual(requestLines.firstObject as? String, "GET \(path) HTTP/1.0")
    }

    func testFetchThrowsOnHttpError() throws {
        try startFakeMediaServer(status: "404 Not Found", body: Data("nope".utf8))

        XCTAssertThrowsError(try MediaFetcher.fetchSync(url: mediaURL("/blobs/missing"))) { error in
            XCTAssertEqual((error as? URLError)?.code, .fileDoesNotExist)
        }
    }

    func testFetchThrowsOnTruncatedBody() throws {
        // Server advertises more bytes than it sends, then closes: an
        // HTTP/1.0 EOF that must NOT be mistaken for completion (a backend
        // dying mid-response looks exactly like this).
        try startFakeMediaServer(
            body: Data(repeating: 0x42, count: 1000),
            contentLengthOverride: 5000
        )

        XCTAssertThrowsError(try MediaFetcher.fetchSync(url: mediaURL("/blobs/cut"))) { error in
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
    }

    func testFetchFailsWhenBackendSocketAbsent() {
        // No server started: connect retries exhaust and surface an error
        // instead of hanging.
        XCTAssertThrowsError(try MediaFetcher.fetchSync(url: mediaURL("/blobs/x"))) { error in
            XCTAssertEqual((error as? URLError)?.code, .cannotConnectToHost)
        }
    }

    func testFetchFailsWhenSocketPathNotConfigured() {
        MediaFetcher.socketPathProvider = nil
        XCTAssertThrowsError(try MediaFetcher.fetchSync(url: mediaURL("/blobs/x"))) { error in
            XCTAssertEqual((error as? URLError)?.code, .cannotConnectToHost)
        }
    }

    func testFetchToFileSnapshotsBodyWithContentTypeExtension() throws {
        let payload = Data("share me".utf8)
        try startFakeMediaServer(headers: ["Content-Type": "image/png"], body: payload)

        let dir = URL(fileURLWithPath: tempDir).appendingPathComponent("shared")
        let fileUrl = try MediaFetcher.fetchToFile(
            url: mediaURL("/blobs/proj/drive/photo/original/aabb"),
            directory: dir
        )

        XCTAssertEqual(fileUrl.pathExtension, "png")
        XCTAssertEqual(try Data(contentsOf: fileUrl), payload)
    }

    func testFetchToFileDistinguishesVariantsSharingABlobName() throws {
        let payload = Data("v".utf8)
        try startFakeMediaServer(body: payload)

        let dir = URL(fileURLWithPath: tempDir).appendingPathComponent("shared")
        let original = try MediaFetcher.fetchToFile(
            url: mediaURL("/blobs/p/d/photo/original/aabb"), directory: dir)
        let thumbnail = try MediaFetcher.fetchToFile(
            url: mediaURL("/blobs/p/d/photo/thumbnail/aabb"), directory: dir)

        XCTAssertNotEqual(original, thumbnail)
    }

    func testCanHandleMatchesOnlyMediaURLs() {
        XCTAssertTrue(MediaFetcher.canHandle(URL(string: "comapeo://media/blobs/x")!))
        XCTAssertFalse(MediaFetcher.canHandle(URL(string: "comapeo://other/blobs/x")!))
        XCTAssertFalse(MediaFetcher.canHandle(URL(string: "https://media/blobs/x")!))
    }

    func testExtensionMappingMirrorsAndroid() {
        XCTAssertEqual(MediaFetcher.extensionForMimeType("image/jpeg"), "jpg")
        XCTAssertEqual(MediaFetcher.extensionForMimeType("image/PNG; charset=binary"), "png")
        XCTAssertEqual(MediaFetcher.extensionForMimeType("video/quicktime"), "mov")
        XCTAssertNil(MediaFetcher.extensionForMimeType("application/x-unknown"))
        XCTAssertNil(MediaFetcher.extensionForMimeType(nil))
    }

    // MARK: - MediaURLProtocol (streaming path)

    func testURLProtocolDeliversBodyAndMimeTypeThroughURLSession() throws {
        var payload = Data(count: 300_000)
        payload.withUnsafeMutableBytes { buf in
            for i in 0..<buf.count { buf[i] = UInt8((i &* 7) & 0xff) }
        }
        try startFakeMediaServer(headers: ["Content-Type": "image/png"], body: payload)

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MediaURLProtocol.self]
        let session = URLSession(configuration: config)

        let done = expectation(description: "request completes")
        var received: (data: Data?, mimeType: String?, error: Error?)
        let task = session.dataTask(with: mediaURL("/blobs/p/d/photo/original/cc")) {
            data, response, error in
            received = (data, response?.mimeType, error)
            done.fulfill()
        }
        task.resume()
        wait(for: [done], timeout: 15)

        XCTAssertNil(received.error)
        XCTAssertEqual(received.mimeType, "image/png")
        XCTAssertEqual(received.data, payload)
    }

    func testURLProtocolSurfacesHttpErrorAsFailure() throws {
        try startFakeMediaServer(status: "404 Not Found", body: Data())

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MediaURLProtocol.self]
        let session = URLSession(configuration: config)

        let done = expectation(description: "request fails")
        var receivedError: Error?
        session.dataTask(with: mediaURL("/blobs/missing")) { _, _, error in
            receivedError = error
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)

        XCTAssertEqual((receivedError as? URLError)?.code, .fileDoesNotExist)
    }
}

private extension Data {
    /// `true` when `sequence` occurs anywhere in the data.
    func contains(sequence: [UInt8]) -> Bool {
        guard count >= sequence.count else { return false }
        return withUnsafeBytes { (ptr: UnsafeRawBufferPointer) -> Bool in
            let bytes = ptr.bindMemory(to: UInt8.self)
            outer: for i in 0...(count - sequence.count) {
                for j in 0..<sequence.count where bytes[i + j] != sequence[j] {
                    continue outer
                }
                return true
            }
            return false
        }
    }
}
