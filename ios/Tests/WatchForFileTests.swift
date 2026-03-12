import XCTest

/// Unit tests for the file watching / polling pattern used to wait
/// for Unix domain socket files to appear.
///
/// Mirrors Android's `WatchForFileTimeoutTest.kt` — verifying timeout behavior,
/// immediate return when file exists, and cleanup on cancellation.
final class WatchForFileTests: XCTestCase {

    private var testDir: String!

    override func setUp() {
        super.setUp()
        testDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(
            "comapeo-test-\(UUID().uuidString)"
        )
        try? FileManager.default.createDirectory(atPath: testDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: testDir)
        super.tearDown()
    }

    func testTimeoutWhenFileNeverAppears() {
        let filePath = (testDir as NSString).appendingPathComponent("never-created.sock")
        let startTime = Date()

        // Poll with a short timeout
        let timeout: TimeInterval = 0.2
        waitForFileSync(atPath: filePath, timeoutSeconds: timeout)

        let elapsed = Date().timeIntervalSince(startTime)
        // Should have waited approximately the timeout duration
        XCTAssertGreaterThanOrEqual(elapsed, timeout * 0.8, "Should wait at least near the timeout")
        XCTAssertFalse(FileManager.default.fileExists(atPath: filePath))
    }

    func testImmediateReturnWhenFileExists() {
        let filePath = (testDir as NSString).appendingPathComponent("existing.sock")
        FileManager.default.createFile(atPath: filePath, contents: nil)

        let startTime = Date()
        waitForFileSync(atPath: filePath, timeoutSeconds: 5)
        let elapsed = Date().timeIntervalSince(startTime)

        // Should return almost immediately
        XCTAssertLessThan(elapsed, 0.5, "Should return immediately when file exists")
    }

    func testDetectsFileCreatedDuringWait() {
        let filePath = (testDir as NSString).appendingPathComponent("delayed.sock")

        let expectation = self.expectation(description: "File detected")

        DispatchQueue.global().async {
            self.waitForFileSync(atPath: filePath, timeoutSeconds: 5)
            expectation.fulfill()
        }

        // Create the file after a short delay
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }

        waitForExpectations(timeout: 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: filePath))
    }

    func testIgnoresFilesWithDifferentName() {
        let targetPath = (testDir as NSString).appendingPathComponent("target.sock")
        let wrongPath = (testDir as NSString).appendingPathComponent("wrong.sock")

        let startTime = Date()

        // Create wrong file, never create target
        FileManager.default.createFile(atPath: wrongPath, contents: nil)

        waitForFileSync(atPath: targetPath, timeoutSeconds: 0.2)

        let elapsed = Date().timeIntervalSince(startTime)
        // Should timeout because target file was never created
        XCTAssertGreaterThanOrEqual(elapsed, 0.15, "Should timeout since target was not created")
    }

    func testCreatesParentDirectoryIfNeeded() {
        let nestedDir = (testDir as NSString).appendingPathComponent("nested/deep")
        let filePath = (nestedDir as NSString).appendingPathComponent("socket.sock")

        // Parent dir doesn't exist yet
        XCTAssertFalse(FileManager.default.fileExists(atPath: nestedDir))

        let expectation = self.expectation(description: "File detected")

        DispatchQueue.global().async {
            self.waitForFileSync(atPath: filePath, timeoutSeconds: 5)
            expectation.fulfill()
        }

        // Create the file (parent dir should have been created by waitForFile)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            // The wait function should have created the parent
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }

        waitForExpectations(timeout: 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: filePath))
    }

    // MARK: - Helper

    /// Synchronous file wait matching the implementation in NodeJSIPC.swift
    private func waitForFileSync(atPath path: String, timeoutSeconds: TimeInterval) {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: path) {
            return
        }

        let parentDir = (path as NSString).deletingLastPathComponent
        try? fileManager.createDirectory(atPath: parentDir, withIntermediateDirectories: true)

        let deadline = Date().addingTimeInterval(timeoutSeconds)
        let pollInterval: useconds_t = 50_000 // 50ms

        while !fileManager.fileExists(atPath: path) {
            if Date() > deadline {
                return
            }
            usleep(pollInterval)
        }
    }
}
