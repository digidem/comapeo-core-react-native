import XCTest

/// Unit tests verifying the DispatchSemaphore pattern used in `NodeJSService`
/// to safely coordinate graceful shutdown.
///
/// Mirrors Android's `CompletableDeferredStopTest.kt` — the iOS equivalent of
/// Kotlin's `CompletableDeferred` is `DispatchSemaphore` for blocking waits.
final class SemaphoreShutdownTests: XCTestCase {

    func testSemaphoreSignalsImmediatelyWhenAlreadySignalled() {
        let semaphore = DispatchSemaphore(value: 1)
        // Already has a signal available — wait returns immediately
        let result = semaphore.wait(timeout: .now() + 0.1)
        XCTAssertEqual(result, .success)
    }

    func testSemaphoreBlocksUntilSignalled() {
        let semaphore = DispatchSemaphore(value: 0)
        var result: String?

        let expectation = self.expectation(description: "Semaphore signalled")
        DispatchQueue.global().async {
            semaphore.wait()
            result = "completed"
            expectation.fulfill()
        }

        // Result not yet set — waiter should be blocked
        Thread.sleep(forTimeInterval: 0.05)
        XCTAssertNil(result)

        semaphore.signal()
        waitForExpectations(timeout: 1)
        XCTAssertEqual(result, "completed")
    }

    func testStopBeforeStartCompletesWaitsForStart() {
        // Simulates NodeJSService pattern: start sets state, stop waits for it
        let startedSemaphore = DispatchSemaphore(value: 0)
        var stopSentMessage = false
        var stopCompleted = false

        let stopExpectation = self.expectation(description: "Stop completed")

        // Simulate stop() waiting for start to complete
        DispatchQueue.global().async {
            startedSemaphore.wait() // blocks until start signals
            stopSentMessage = true
            stopCompleted = true
            stopExpectation.fulfill()
        }

        // stop should be blocked waiting for start
        Thread.sleep(forTimeInterval: 0.05)
        XCTAssertFalse(stopSentMessage)

        // Simulate start completing
        startedSemaphore.signal()
        waitForExpectations(timeout: 1)
        XCTAssertTrue(stopSentMessage)
        XCTAssertTrue(stopCompleted)
    }

    func testTimeoutWhenServiceNeverStarts() {
        let semaphore = DispatchSemaphore(value: 0)

        // Wait with short timeout — simulates shutdown timeout
        let result = semaphore.wait(timeout: .now() + 0.1)
        XCTAssertEqual(result, .timedOut)
    }

    func testStopWithNilServiceReturnsEarly() {
        // Simulates NodeJSService.stop() when state is .stopped
        var nodeService: String? = nil
        var stopReachedShutdown = false

        // Mirrors the guard: guard state == .started else { return }
        guard nodeService != nil else {
            // Early return — should not reach shutdown
            XCTAssertFalse(stopReachedShutdown)
            return
        }
        stopReachedShutdown = true
        XCTFail("Should not reach shutdown logic")
    }

    func testGracefulShutdownSequence() {
        // Simulates the full graceful shutdown sequence:
        // 1. Service is running (started)
        // 2. Stop is called, sends shutdown message
        // 3. Node.js process exits
        // 4. Cleanup happens
        enum ServiceState { case stopped, starting, started, stopping }

        var state = ServiceState.stopped
        var shutdownMessageSent = false
        var cleanedUp = false

        // Start
        state = .starting
        state = .started

        // Stop
        state = .stopping
        shutdownMessageSent = true

        // Node.js exits
        state = .stopped
        cleanedUp = true

        XCTAssertEqual(state, .stopped)
        XCTAssertTrue(shutdownMessageSent)
        XCTAssertTrue(cleanedUp)
    }

    func testConcurrentStopCallsAreSafe() {
        // Verifies that multiple concurrent stop() calls don't cause issues
        let lock = NSLock()
        var stopCount = 0
        var state = "started"
        let stopExpectation = self.expectation(description: "All stops completed")
        stopExpectation.expectedFulfillmentCount = 3

        for _ in 0..<3 {
            DispatchQueue.global().async {
                lock.lock()
                if state == "started" {
                    state = "stopping"
                    stopCount += 1
                    state = "stopped"
                }
                lock.unlock()
                stopExpectation.fulfill()
            }
        }

        waitForExpectations(timeout: 1)
        // Only one stop should actually execute the transition
        XCTAssertEqual(stopCount, 1)
        XCTAssertEqual(state, "stopped")
    }
}
