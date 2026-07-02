import XCTest
@testable import ComapeoCore

/// Classification boundary cases. Mirrors `DeviceTagsTest.kt`.
/// `classify` takes raw RAM bytes + core count so no `ProcessInfo` mock
/// is needed — pure value tests, simulator-free.
final class DeviceTagsTests: XCTestCase {
    private let gb: UInt64 = 1024 * 1024 * 1024

    func testExactly3GbAnd4CoresIsMid() {
        XCTAssertEqual(DeviceTags.classify(totalMemBytes: 3 * gb, cores: 4), DeviceTags.classMid)
    }

    func testJustUnder3GbIsLow() {
        XCTAssertEqual(DeviceTags.classify(totalMemBytes: 3 * gb - 1, cores: 4), DeviceTags.classLow)
    }

    func testThreeCoresIsLowEvenWithAmpleRam() {
        XCTAssertEqual(DeviceTags.classify(totalMemBytes: 8 * gb, cores: 3), DeviceTags.classLow)
    }

    func testExactly6GbAnd6CoresIsHigh() {
        XCTAssertEqual(DeviceTags.classify(totalMemBytes: 6 * gb, cores: 6), DeviceTags.classHigh)
    }

    func testSixGbButOnlyFiveCoresIsMid() {
        XCTAssertEqual(DeviceTags.classify(totalMemBytes: 6 * gb, cores: 5), DeviceTags.classMid)
    }

    func testOsMajorTakesLeadingComponent() {
        XCTAssertEqual(DeviceTags.osMajor(systemVersion: "17"), "ios.17")
        XCTAssertEqual(DeviceTags.osMajor(systemVersion: "16.5.1"), "ios.16")
        XCTAssertEqual(DeviceTags.osMajor(systemVersion: ""), "ios.0")
    }
}
