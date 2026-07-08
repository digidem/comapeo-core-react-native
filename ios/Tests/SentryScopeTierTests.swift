import Sentry
import XCTest

@testable import ComapeoCore

/// Per-tier field assertions for `SentryScopeTier` — the §9b.3 context
/// allowlists and the §9b.4 boot-transaction slimming, exercised on
/// constructed `Event`s the way the `beforeSend` hook receives them.
final class SentryScopeTierTests: XCTestCase {

    private func fullEvent() -> Event {
        let event = Event()
        event.context = [
            "device": [
                "manufacturer": "Apple",
                "model": "iPhone14,4",
                "model_id": "D16AP",
                "family": "iOS",
                "arch": "arm64e",
                "simulator": false,
                "processor_count": 6,
                "memory_size": 4_000_000_000,
                // What a "128 GB" phone actually reports after formatting.
                "storage_size": Int64(119) * (1 << 30),
                // Fingerprint-friendly extras that must not ship at diagnostic.
                "free_memory": 123_456_789,
                "usable_memory": 3_000_000_000,
                "locale": "es_PE",
                "screen_width_pixels": 1170,
                "screen_height_pixels": 2532,
                "thermal_state": "nominal",
                "orientation": "portrait",
                "battery_level": 42,
            ],
            "os": [
                "name": "iOS",
                "version": "17.5.1",
                "build": "21F90",
                "kernel_version": "Darwin Kernel Version 23.5.0",
                "rooted": false,
            ],
            "app": [
                "app_identifier": "com.comapeo.app",
                "app_version": "1.2.3",
                "app_build": "456",
                "app_name": "CoMapeo",
                "app_start_time": "2026-07-08T00:00:00Z",
                "device_app_hash": "deadbeef",
                "build_type": "app store",
            ],
            "culture": [
                "locale": "es_PE",
                "timezone": "America/Lima",
            ],
        ]
        return event
    }

    // MARK: - Device context

    func testDiagnosticKeepsCoarseDeviceIdentity() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: false)
        let device = event.context?["device"]
        XCTAssertEqual(device?["manufacturer"] as? String, "Apple")
        XCTAssertEqual(device?["model"] as? String, "iPhone14,4")
        XCTAssertEqual(device?["model_id"] as? String, "D16AP")
        XCTAssertEqual(device?["family"] as? String, "iOS")
        XCTAssertEqual(device?["arch"] as? String, "arm64e")
        XCTAssertEqual(device?["simulator"] as? Bool, false)
        XCTAssertEqual(device?["processor_count"] as? Int, 6)
        XCTAssertEqual(device?["memory_size"] as? Int, 4_000_000_000)
    }

    func testDiagnosticDropsFingerprintFriendlyDeviceFields() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: false)
        let device = event.context?["device"]
        XCTAssertNil(device?["free_memory"])
        XCTAssertNil(device?["usable_memory"])
        XCTAssertNil(device?["locale"])
        XCTAssertNil(device?["screen_width_pixels"])
        XCTAssertNil(device?["screen_height_pixels"])
        XCTAssertNil(device?["thermal_state"])
        XCTAssertNil(device?["orientation"])
        XCTAssertNil(device?["battery_level"])
    }

    func testUsageTierAddsScreenMetricsAndLocaleBack() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: true)
        let device = event.context?["device"]
        XCTAssertEqual(device?["screen_width_pixels"] as? Int, 1170)
        XCTAssertEqual(device?["screen_height_pixels"] as? Int, 2532)
        XCTAssertEqual(device?["locale"] as? String, "es_PE")
        // Not in the usage-tier add-back list — dropped at both tiers.
        XCTAssertNil(device?["free_memory"])
        XCTAssertNil(device?["thermal_state"])
        XCTAssertNil(device?["battery_level"])
    }

    func testStorageSizeIsBucketedAtBothTiers() {
        for usage in [false, true] {
            let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: usage)
            let storage = (event.context?["device"]?["storage_size"] as? NSNumber)?.int64Value
            XCTAssertEqual(storage, Int64(128) * (1 << 30))
        }
    }

    func testBucketStorageSizeRoundsUpToStandardSizes() {
        let gb: Int64 = 1 << 30
        XCTAssertEqual(SentryScopeTier.bucketStorageSize(1), 32 * gb)
        XCTAssertEqual(SentryScopeTier.bucketStorageSize(32 * gb), 32 * gb)
        XCTAssertEqual(SentryScopeTier.bucketStorageSize(32 * gb + 1), 64 * gb)
        XCTAssertEqual(SentryScopeTier.bucketStorageSize(238 * gb), 256 * gb)
        XCTAssertEqual(SentryScopeTier.bucketStorageSize(4096 * gb), 1024 * gb)
    }

    // MARK: - OS / app / culture contexts

    func testDiagnosticKeepsOsNameAndVersionOnly() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: false)
        let os = event.context?["os"]
        XCTAssertEqual(os?["name"] as? String, "iOS")
        XCTAssertEqual(os?["version"] as? String, "17.5.1")
        XCTAssertNil(os?["build"])
        XCTAssertNil(os?["kernel_version"])
        XCTAssertNil(os?["rooted"])
    }

    func testUsageTierAddsKernelAndBuildBack() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: true)
        let os = event.context?["os"]
        XCTAssertEqual(os?["build"] as? String, "21F90")
        XCTAssertEqual(os?["kernel_version"] as? String, "Darwin Kernel Version 23.5.0")
    }

    func testDiagnosticKeepsAppIdVersionBuildOnly() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: false)
        let app = event.context?["app"]
        XCTAssertEqual(app?["app_identifier"] as? String, "com.comapeo.app")
        XCTAssertEqual(app?["app_version"] as? String, "1.2.3")
        XCTAssertEqual(app?["app_build"] as? String, "456")
        XCTAssertNil(app?["app_name"])
        XCTAssertNil(app?["app_start_time"])
        XCTAssertNil(app?["device_app_hash"])
    }

    func testUsageTierAddsAppNameBackButNotDeviceAppHash() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: true)
        let app = event.context?["app"]
        XCTAssertEqual(app?["app_name"] as? String, "CoMapeo")
        XCTAssertNil(app?["device_app_hash"])
        XCTAssertNil(app?["app_start_time"])
    }

    func testDiagnosticDropsCultureEntirely() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: false)
        XCTAssertNil(event.context?["culture"])
    }

    func testUsageTierKeepsCulture() {
        let event = SentryScopeTier.trimEvent(fullEvent(), applicationUsageData: true)
        XCTAssertEqual(event.context?["culture"]?["locale"] as? String, "es_PE")
    }

    // MARK: - Boot transaction slimming (§9b.4)

    private func bootTransactionEvent() -> Event {
        let event = Event()
        event.type = "transaction"
        event.transaction = "comapeo.boot"
        event.tags = [
            SentryTags.proc: SentryTags.procMain,
            SentryTags.layer: SentryTags.layerNative,
            "boot.kind": "user-foreground",
        ]
        return event
    }

    func testDiagnosticSlimsBootTransactionTagsToAllowlist() {
        let event = SentryScopeTier.trimEvent(
            bootTransactionEvent(), applicationUsageData: false
        )
        XCTAssertEqual(event.tags?[SentryTags.proc], SentryTags.procMain)
        XCTAssertEqual(event.tags?[SentryTags.layer], SentryTags.layerNative)
        XCTAssertNil(event.tags?["boot.kind"])
    }

    func testUsageTierKeepsBootTransactionTags() {
        let event = SentryScopeTier.trimEvent(
            bootTransactionEvent(), applicationUsageData: true
        )
        XCTAssertEqual(event.tags?["boot.kind"], "user-foreground")
    }

    func testNonBootEventTagsAreUntouched() {
        let event = Event()
        event.tags = ["comapeo.phase": "rootkey"]
        let processed = SentryScopeTier.trimEvent(event, applicationUsageData: false)
        XCTAssertEqual(processed.tags?["comapeo.phase"], "rootkey")
    }

    // MARK: - Boot span data stripping

    func testBootSpanDataIsStrippedAtDiagnosticOnly() {
        XCTAssertTrue(
            SentryScopeTier.shouldStripBootSpanData(
                operation: "boot.rootkey-load", applicationUsageData: false
            )
        )
        XCTAssertFalse(
            SentryScopeTier.shouldStripBootSpanData(
                operation: "boot.rootkey-load", applicationUsageData: true
            )
        )
        XCTAssertFalse(
            SentryScopeTier.shouldStripBootSpanData(
                operation: "rpc.server", applicationUsageData: false
            )
        )
    }
}
