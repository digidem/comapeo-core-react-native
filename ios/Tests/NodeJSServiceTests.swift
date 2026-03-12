import XCTest
@testable import ComapeoCore

/// Behavioral tests for NodeJSService startup and graceful shutdown.
///
/// These tests use a mock Unix domain socket server to simulate the Node.js
/// process, verifying that:
/// - The service transitions through the correct states
/// - Shutdown sends a `{"type":"shutdown"}` message over the state IPC socket
/// - Timeout-based cleanup works when Node.js doesn't respond
/// - The service can be restarted after shutdown
/// - Concurrent stop calls are safe
///
/// This is the iOS equivalent of testing the Android `ComapeoCoreService` +
/// `NodeJSService` graceful shutdown behavior.
final class NodeJSServiceTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        testDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(
            "comapeo-service-test-\(UUID().uuidString)"
        )
        try? FileManager.default.createDirectory(atPath: testDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: testDir)
        super.tearDown()
    }

    // MARK: - Mock Server Helpers

    /// Creates a Unix domain socket server at the given path.
    private func createMockServer(socketPath: String) throws -> Int32 {
        // Remove any existing socket file
        unlink(socketPath)

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "test", code: Int(errno)) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        let sunPathSize = MemoryLayout.size(ofValue: addr.sun_path)
        withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
            let ptr = rawBuf.baseAddress!.assumingMemoryBound(to: CChar.self)
            for (i, byte) in pathBytes.enumerated() where i < sunPathSize {
                ptr[i] = byte
            }
        }

        let addrLen = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
        let bindResult = withUnsafePointer(to: &addr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.bind(fd, sockaddrPtr, addrLen)
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw NSError(domain: "test", code: Int(errno))
        }
        guard Darwin.listen(fd, 1) == 0 else {
            close(fd)
            throw NSError(domain: "test", code: Int(errno))
        }
        return fd
    }

    private func acceptClient(serverFd: Int32) -> Int32 {
        return Darwin.accept(serverFd, nil, nil)
    }

    /// Read a length-prefixed message from a file descriptor.
    private func receiveFramedMessage(fd: Int32) -> String? {
        var lengthBuffer = [UInt8](repeating: 0, count: 4)
        let bytesRead = Darwin.read(fd, &lengthBuffer, 4)
        guard bytesRead == 4 else { return nil }

        let messageLength = Int(
            UInt32(lengthBuffer[0]) |
            UInt32(lengthBuffer[1]) << 8 |
            UInt32(lengthBuffer[2]) << 16 |
            UInt32(lengthBuffer[3]) << 24
        )

        var messageBuffer = [UInt8](repeating: 0, count: messageLength)
        var totalRead = 0
        while totalRead < messageLength {
            let n = Darwin.read(fd, &messageBuffer[totalRead], messageLength - totalRead)
            guard n > 0 else { return nil }
            totalRead += n
        }

        return String(bytes: messageBuffer, encoding: .utf8)
    }

    // MARK: - Startup Tests

    func testStartTransitionsToStarted() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        XCTAssertEqual(service.state, .started)
        service.cleanup()
    }

    func testStartFromNonStoppedStateIsIgnored() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "State reached STARTED")

        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Second start should be ignored
        var stateChanges = [NodeJSService.State]()
        service.onStateChange = { state in
            stateChanges.append(state)
        }

        service.start()
        Thread.sleep(forTimeInterval: 0.2)

        XCTAssertTrue(stateChanges.isEmpty, "No state changes should occur on duplicate start")
        XCTAssertEqual(service.state, .started)
        service.cleanup()
    }

    // MARK: - Shutdown Tests

    func testStopSendsShutdownMessageOverIPC() throws {
        let service = NodeJSService(filesDir: testDir)

        // Create mock state socket server BEFORE starting the service
        // (the service's IPC client will connect to this)
        let stateServerFd = try createMockServer(socketPath: service.stateSocketPath)
        defer { close(stateServerFd) }

        let startedExpectation = expectation(description: "State reached STARTED")
        service.onStateChange = { state in
            if state == .started {
                startedExpectation.fulfill()
            }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Accept the IPC client connection from the service
        let clientFd = acceptClient(serverFd: stateServerFd)
        XCTAssertGreaterThanOrEqual(clientFd, 0, "Should accept IPC client")
        defer { close(clientFd) }

        // Give the IPC connection time to fully establish
        Thread.sleep(forTimeInterval: 0.3)

        // Stop the service on a background thread (stop() blocks)
        DispatchQueue.global().async {
            service.stop(timeout: 2)
        }

        // Read the shutdown message from the mock server side
        let message = receiveFramedMessage(fd: clientFd)
        XCTAssertEqual(message, #"{"type":"shutdown"}"#, "Should receive shutdown message")

        // Give stop() time to complete (it will timeout since we don't signal)
        Thread.sleep(forTimeInterval: 3)

        XCTAssertEqual(service.state, .stopped)
    }

    func testStopTransitionsToStopped() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        var stateSequence = [NodeJSService.State]()
        service.onStateChange = { state in
            stateSequence.append(state)
        }

        // stop() will timeout since there's no real Node.js, but cleanup
        // should still transition to STOPPED
        service.stop(timeout: 0.5)

        XCTAssertEqual(service.state, .stopped)
        XCTAssertTrue(stateSequence.contains(.stopping), "Should transition through STOPPING")
        XCTAssertTrue(stateSequence.contains(.stopped), "Should end at STOPPED")
    }

    func testStopWhenAlreadyStoppedIsIgnored() {
        let service = NodeJSService(filesDir: testDir)
        XCTAssertEqual(service.state, .stopped)

        var stateChanges = [NodeJSService.State]()
        service.onStateChange = { stateChanges.append($0) }

        service.stop(timeout: 0.5)

        XCTAssertTrue(stateChanges.isEmpty, "stop() on stopped service should be a no-op")
        XCTAssertEqual(service.state, .stopped)
    }

    func testShutdownTimesOutAndCleansUp() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        let startTime = Date()
        service.stop(timeout: 0.5)
        let elapsed = Date().timeIntervalSince(startTime)

        // Should have waited approximately the timeout duration, then cleaned up
        XCTAssertGreaterThanOrEqual(elapsed, 0.4, "Should wait near the timeout")
        XCTAssertLessThan(elapsed, 3, "Should not wait much longer than timeout")
        XCTAssertEqual(service.state, .stopped)
    }

    func testSocketFilesDeletedAfterStop() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        service.stop(timeout: 0.5)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: service.comapeoSocketPath), "comapeo.sock should be deleted")
        XCTAssertFalse(fm.fileExists(atPath: service.stateSocketPath), "state.sock should be deleted")
    }

    // MARK: - Restart Tests

    func testCanRestartAfterStop() {
        let service = NodeJSService(filesDir: testDir)

        // First cycle
        let started1 = expectation(description: "Started first time")
        service.onStateChange = { state in
            if state == .started { started1.fulfill() }
        }
        service.start()
        waitForExpectations(timeout: 5)
        service.stop(timeout: 0.5)
        XCTAssertEqual(service.state, .stopped)

        // Second cycle
        let started2 = expectation(description: "Started second time")
        service.onStateChange = { state in
            if state == .started { started2.fulfill() }
        }
        service.start()
        waitForExpectations(timeout: 5)
        XCTAssertEqual(service.state, .started)
        service.cleanup()
    }

    // MARK: - Concurrency Tests

    func testConcurrentStopCallsAreSafe() {
        let service = NodeJSService(filesDir: testDir)
        let startedExpectation = expectation(description: "Started")

        service.onStateChange = { state in
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        let group = DispatchGroup()

        // Fire 3 concurrent stop() calls
        for _ in 0..<3 {
            group.enter()
            DispatchQueue.global().async {
                service.stop(timeout: 0.5)
                group.leave()
            }
        }

        let result = group.wait(timeout: .now() + 5)
        XCTAssertEqual(result, .success, "All stop calls should complete")
        XCTAssertEqual(service.state, .stopped)
    }

    // MARK: - State Transition Order Tests

    func testFullLifecycleStateTransitions() {
        let service = NodeJSService(filesDir: testDir)
        var transitions = [NodeJSService.State]()
        let lock = NSLock()

        service.onStateChange = { state in
            lock.lock()
            transitions.append(state)
            lock.unlock()
        }

        // Start
        let startedExpectation = expectation(description: "Started")
        service.onStateChange = { state in
            lock.lock()
            transitions.append(state)
            lock.unlock()
            if state == .started { startedExpectation.fulfill() }
        }

        service.start()
        waitForExpectations(timeout: 5)

        // Stop
        service.stop(timeout: 0.5)

        lock.lock()
        let finalTransitions = transitions
        lock.unlock()

        // Verify state transition order
        XCTAssertTrue(finalTransitions.count >= 3, "Should have at least STARTING, STARTED, STOPPING transitions")

        // Find the indices to verify ordering
        let startingIdx = finalTransitions.firstIndex(of: .starting)
        let startedIdx = finalTransitions.firstIndex(of: .started)
        let stoppingIdx = finalTransitions.firstIndex(of: .stopping)
        let stoppedIdx = finalTransitions.firstIndex(of: .stopped)

        XCTAssertNotNil(startingIdx, "Should have STARTING transition")
        XCTAssertNotNil(startedIdx, "Should have STARTED transition")
        XCTAssertNotNil(stoppingIdx, "Should have STOPPING transition")
        XCTAssertNotNil(stoppedIdx, "Should have STOPPED transition")

        if let si = startingIdx, let sa = startedIdx, let sp = stoppingIdx, let sd = stoppedIdx {
            XCTAssertLessThan(si, sa, "STARTING should come before STARTED")
            XCTAssertLessThan(sa, sp, "STARTED should come before STOPPING")
            XCTAssertLessThan(sp, sd, "STOPPING should come before STOPPED")
        }
    }
}
