import CoreBluetooth
import Foundation

/// The iOS half of BLE discovery — a dumb radio driver commanded by the
/// backend's discovery controller over the same control-socket frames
/// as the Android FGS engine (docs/ble-discovery.md §6c). Foreground
/// only: iOS backgrounding freezes the embedded Node thread, so there
/// is nobody to act on sightings anyway.
///
/// - **Scanning** (discovering Android peers): CoreBluetooth cannot
///   hardware-filter on manufacturer data, so we scan broadly with
///   `allowDuplicates` (needed for the RSSI stream and sync-state
///   updates; legal in foreground) and software-filter on the
///   company-ID + "CM" prefix before forwarding `ble-sighting` frames.
/// - **Being discovered** (by Android peers): iOS cannot put
///   manufacturer data in an advertisement, so we advertise the CoMapeo
///   service UUID and serve the same 21-byte payload as the sync-state
///   characteristic's value. Android reads it over GATT and forwards
///   the identical sighting frame.
/// - **Status**: `ble-status` frames mirror the Android engine's shape
///   (scanning/advertising/blockers/lastError).
///
/// All state is confined to `queue`; public methods hop onto it.
final class BleDiscoveryEngine: NSObject {
    /// Mirrored in `backend/lib/ble-codec.js` and `BleProtocol.kt`.
    static let serviceUUID = CBUUID(string: "C3992D3B-AF17-484C-AB89-24AE377279D4")
    static let syncStateCharacteristicUUID = CBUUID(string: "1E2909D4-767B-4635-AFFE-97F936B91A48")

    private let sendFrame: (String) -> Void
    private let queue = DispatchQueue(label: "com.comapeo.core.ble")

    private var central: CBCentralManager?
    private var peripheral: CBPeripheralManager?
    private var payload: Data?
    private var isRunning = false
    private var inForeground = true
    private var serviceAdded = false

    /// Per-sender forward throttle: unchanged payloads at most once per
    /// second, changed payloads immediately (mirrors `SightingThrottle`).
    private var lastForward: [String: (at: CFAbsoluteTime, hash: Int)] = [:]

    init(sendFrame: @escaping (String) -> Void) {
        self.sendFrame = sendFrame
    }

    /// `payload` is the raw 21-byte advertisement (base64-decoded by the
    /// caller); nil = scan-only.
    func start(payload: Data?) {
        queue.async {
            self.isRunning = true
            self.payload = payload
            // Lazy: constructing a CB manager triggers the system
            // Bluetooth permission prompt, so it must not happen before
            // discovery is actually enabled.
            if self.central == nil {
                self.central = CBCentralManager(delegate: self, queue: self.queue)
            }
            if self.peripheral == nil {
                self.peripheral = CBPeripheralManager(delegate: self, queue: self.queue)
            }
            self.refreshRadios()
        }
    }

    func setAdvertisement(payload: Data?) {
        queue.async {
            guard self.isRunning else { return }
            self.payload = payload
            self.refreshAdvertising()
            self.sendStatus()
        }
    }

    func stop() {
        queue.async {
            guard self.isRunning else { return }
            self.isRunning = false
            self.central?.stopScan()
            if self.peripheral?.isAdvertising == true {
                self.peripheral?.stopAdvertising()
            }
            self.lastForward.removeAll()
            self.sendStatus()
        }
    }

    /// Foreground transitions from `AppLifecycleDelegate`. Scanning is
    /// foreground-only; the advertisement stays up (backgrounded iOS
    /// advertising degrades to the overflow area — free, and later
    /// useful for the GATT-wake path).
    func onForeground() {
        queue.async {
            self.inForeground = true
            self.refreshRadios()
        }
    }

    func onBackground() {
        queue.async {
            self.inForeground = false
            self.central?.stopScan()
            self.sendStatus()
        }
    }

    // MARK: - queue-confined

    private func refreshRadios() {
        refreshScanning()
        refreshAdvertising()
        sendStatus()
    }

    private func refreshScanning() {
        guard let central else { return }
        guard isRunning, inForeground, central.state == .poweredOn else {
            if central.state == .poweredOn { central.stopScan() }
            return
        }
        guard !central.isScanning else { return }
        central.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
    }

    private func refreshAdvertising() {
        guard let peripheral, peripheral.state == .poweredOn else { return }
        guard isRunning, payload != nil else {
            if peripheral.isAdvertising { peripheral.stopAdvertising() }
            return
        }
        if !serviceAdded {
            let characteristic = CBMutableCharacteristic(
                type: Self.syncStateCharacteristicUUID,
                properties: .read,
                value: nil, // dynamic — served from `payload` on each read
                permissions: .readable
            )
            let service = CBMutableService(type: Self.serviceUUID, primary: true)
            service.characteristics = [characteristic]
            peripheral.add(service)
            serviceAdded = true
        }
        if !peripheral.isAdvertising {
            peripheral.startAdvertising([
                CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID]
            ])
        }
    }

    private func forwardSighting(payload: Data, rssi: Int, address: String) {
        let now = CFAbsoluteTimeGetCurrent()
        let hash = payload.hashValue
        if let previous = lastForward[address],
           previous.hash == hash, now - previous.at < 1.0 {
            return
        }
        if lastForward.count > 256 {
            lastForward = lastForward.filter { now - $0.value.at < 300 }
        }
        lastForward[address] = (at: now, hash: hash)
        send([
            "type": "ble-sighting",
            "payload": payload.base64EncodedString(),
            "rssi": rssi,
            "address": address,
        ])
    }

    private func sendStatus() {
        var blockers: [String] = []
        var scanning = "stopped"
        var advertising = "stopped"
        if isRunning {
            switch central?.state {
            case .poweredOn:
                scanning = (inForeground && central?.isScanning == true) ? "active" : "stopped"
            case .poweredOff:
                scanning = "unavailable"
                blockers.append("bluetooth-off")
            case .unauthorized:
                scanning = "unavailable"
                blockers.append("permission-missing")
            case .unsupported:
                scanning = "unavailable"
                blockers.append("no-adapter")
            default:
                scanning = "stopped" // .unknown / .resetting / not yet created
            }
            if payload == nil {
                advertising = "stopped"
            } else {
                switch peripheral?.state {
                case .poweredOn:
                    advertising = peripheral?.isAdvertising == true ? "active" : "stopped"
                case .poweredOff, .unauthorized, .unsupported:
                    advertising = "unavailable"
                default:
                    advertising = "stopped"
                }
            }
        }
        send([
            "type": "ble-status",
            "scanning": scanning,
            "advertising": advertising,
            "blockers": blockers,
        ])
    }

    private func send(_ object: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: bytes, encoding: .utf8)
        else { return }
        sendFrame(json)
    }
}

extension BleDiscoveryEngine: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        refreshScanning()
        sendStatus()
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        // Software "CM" filter: kCBAdvDataManufacturerData is the
        // little-endian company ID (0xFFFF → FF FF) followed by the
        // payload, whose first two bytes are the "CM" magic.
        guard let mfr = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
              mfr.count >= 4,
              mfr[mfr.startIndex] == 0xFF,
              mfr[mfr.startIndex + 1] == 0xFF,
              mfr[mfr.startIndex + 2] == 0x43, // "C"
              mfr[mfr.startIndex + 3] == 0x4D  // "M"
        else { return }
        forwardSighting(
            payload: mfr.subdata(in: (mfr.startIndex + 2)..<mfr.endIndex),
            rssi: RSSI.intValue,
            // iOS hides BLE MACs; the per-peripheral UUID serves the
            // same short-horizon dedup role.
            address: peripheral.identifier.uuidString
        )
    }
}

extension BleDiscoveryEngine: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state != .poweredOn {
            // A power cycle forgets added services; re-add on next start.
            serviceAdded = false
        }
        refreshAdvertising()
        sendStatus()
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didReceiveRead request: CBATTRequest
    ) {
        guard request.characteristic.uuid == Self.syncStateCharacteristicUUID,
              let payload
        else {
            peripheral.respond(to: request, withResult: .attributeNotFound)
            return
        }
        guard request.offset <= payload.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = payload.subdata(in: request.offset..<payload.count)
        peripheral.respond(to: request, withResult: .success)
    }
}
