import XCTest
@testable import ComapeoCore

/// Tests for the `waitForFile` function used to wait for Unix domain socket
/// files to appear before connecting.
///
/// These tests call the actual `waitForFile` implementation (made internal
/// for testability) rather than duplicating it — ensuring the tests break
/// if the real implementation changes.
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

    func testImmediateReturnWhenFileExists() {
        let filePath = (testDir as NSString).appendingPathComponent("existing.sock")
        FileManager.default.createFile(atPath: filePath, contents: nil)

        let startTime = Date()
        waitForFile(atPath: filePath, timeoutSeconds: 5)
        let elapsed = Date().timeIntervalSince(startTime)

        XCTAssertLessThan(elapsed, 0.5, "Should return immediately when file exists")
    }

    func testTimeoutWhenFileNeverAppears() {
        let filePath = (testDir as NSString).appendingPathComponent("never-created.sock")
        let startTime = Date()

        waitForFile(atPath: filePath, timeoutSeconds: 0.2)

        let elapsed = Date().timeIntervalSince(startTime)
        XCTAssertGreaterThanOrEqual(elapsed, 0.15, "Should wait at least near the timeout")
        XCTAssertFalse(FileManager.default.fileExists(atPath: filePath))
    }

    func testDetectsFileCreatedDuringWait() {
        let filePath = (testDir as NSString).appendingPathComponent("delayed.sock")

        let detected = expectation(description: "File detected")

        DispatchQueue.global().async {
            waitForFile(atPath: filePath, timeoutSeconds: 5)
            detected.fulfill()
        }

        // Create the file after a short delay
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }

        waitForExpectations(timeout: 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: filePath))
    }

    func testIgnoresFilesWithDifferentName() {
        let targetPath = (testDir as NSString).appendingPathComponent("target.sock")
        let wrongPath = (testDir as NSString).appendingPathComponent("wrong.sock")

        // Create wrong file, never create target
        FileManager.default.createFile(atPath: wrongPath, contents: nil)

        let startTime = Date()
        waitForFile(atPath: targetPath, timeoutSeconds: 0.2)
        let elapsed = Date().timeIntervalSince(startTime)

        XCTAssertGreaterThanOrEqual(elapsed, 0.15, "Should timeout since target was not created")
    }

    func testCreatesParentDirectoryIfNeeded() {
        let nestedDir = (testDir as NSString).appendingPathComponent("nested/deep")
        let filePath = (nestedDir as NSString).appendingPathComponent("socket.sock")

        // Parent dir doesn't exist yet
        XCTAssertFalse(FileManager.default.fileExists(atPath: nestedDir))

        let detected = expectation(description: "File detected")

        DispatchQueue.global().async {
            waitForFile(atPath: filePath, timeoutSeconds: 5)
            detected.fulfill()
        }

        // Create the file (parent dir should have been created by waitForFile)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }

        waitForExpectations(timeout: 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: filePath))
    }
}
