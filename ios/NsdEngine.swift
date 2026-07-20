import Foundation

/// The iOS DNS-SD half of discovery (docs/ble-discovery.md §4b):
/// publishes core's local-peer server as `_comapeo._tcp` and browses
/// for peers via Bonjour (`NetService` — the daemon-backed API, so no
/// multicast entitlement is needed, unlike raw-socket mDNS in Node).
/// Commanded by the backend over the same `nsd-start`/`nsd-stop`
/// control frames as the Android engine, reporting the same
/// `nsd-peer`/`nsd-peer-lost`/`nsd-status` frames back.
///
/// NetService requires a run loop — everything runs on the main queue.
final class NsdEngine: NSObject {
    static let serviceType = "_comapeo._tcp."

    private let sendFrame: (String) -> Void
    private var published: NetService?
    private var browser: NetServiceBrowser?
    /// Strong refs while resolving — NetService is delegate-callback
    /// driven and would deallocate otherwise.
    private var resolving: Set<NetService> = []
    private var ownName = ""
    private var browsing = "stopped"
    private var registered = "stopped"

    init(sendFrame: @escaping (String) -> Void) {
        self.sendFrame = sendFrame
    }

    func start(name: String, port: Int) {
        DispatchQueue.main.async {
            self.stopOnMain()
            self.ownName = name

            let service = NetService(
                domain: "local.",
                type: Self.serviceType,
                name: name,
                port: Int32(port)
            )
            service.delegate = self
            service.schedule(in: .main, forMode: .common)
            service.publish()
            self.published = service

            let browser = NetServiceBrowser()
            browser.delegate = self
            browser.schedule(in: .main, forMode: .common)
            browser.searchForServices(ofType: Self.serviceType, inDomain: "local.")
            self.browser = browser
            self.sendStatus()
        }
    }

    func stop() {
        DispatchQueue.main.async {
            self.stopOnMain()
            self.sendStatus()
        }
    }

    // MARK: - main-queue only

    private func stopOnMain() {
        published?.stop()
        published = nil
        browser?.stop()
        browser = nil
        resolving.removeAll()
        browsing = "stopped"
        registered = "stopped"
    }

    private func sendStatus(lastError: (scope: String, code: String, message: String)? = nil) {
        var frame: [String: Any] = [
            "type": "nsd-status",
            "browsing": browsing,
            "registered": registered,
            "blockers": [String](),
        ]
        if let lastError {
            frame["lastError"] = [
                "scope": lastError.scope,
                "code": lastError.code,
                "message": lastError.message,
            ]
        }
        send(frame)
    }

    private func send(_ object: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: bytes, encoding: .utf8)
        else { return }
        sendFrame(json)
    }

    /// First IPv4 dotted-quad among a NetService's resolved addresses.
    private func ipv4Address(of service: NetService) -> String? {
        for data in service.addresses ?? [] {
            let address: String? = data.withUnsafeBytes { raw in
                guard let base = raw.baseAddress,
                      raw.count >= MemoryLayout<sockaddr>.size
                else { return nil }
                let family = base.assumingMemoryBound(to: sockaddr.self).pointee.sa_family
                guard family == sa_family_t(AF_INET),
                      raw.count >= MemoryLayout<sockaddr_in>.size
                else { return nil }
                var addr = base.assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
                var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                guard inet_ntop(AF_INET, &addr, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil
                else { return nil }
                return String(cString: buffer)
            }
            if let address { return address }
        }
        return nil
    }
}

extension NsdEngine: NetServiceDelegate {
    func netServiceDidPublish(_ sender: NetService) {
        // The daemon renames on collision; track it for self-filtering.
        if sender === published { ownName = sender.name }
        registered = "active"
        sendStatus()
    }

    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        guard sender === published else { return }
        registered = "unavailable"
        sendStatus(lastError: (
            scope: "register",
            code: "ERR_NSD_REGISTER",
            message: "didNotPublish \(errorDict)"
        ))
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        resolving.remove(sender)
        guard sender.name != ownName, sender.port > 0,
              let address = ipv4Address(of: sender)
        else { return }
        send([
            "type": "nsd-peer",
            "name": sender.name,
            "address": address,
            "port": sender.port,
        ])
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        resolving.remove(sender)
    }
}

extension NsdEngine: NetServiceBrowserDelegate {
    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didFind service: NetService,
        moreComing: Bool
    ) {
        browsing = "active"
        guard service.name != ownName else { return }
        service.delegate = self
        service.schedule(in: .main, forMode: .common)
        resolving.insert(service)
        service.resolve(withTimeout: 10)
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didRemove service: NetService,
        moreComing: Bool
    ) {
        guard service.name != ownName else { return }
        send(["type": "nsd-peer-lost", "name": service.name])
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didNotSearch errorDict: [String: NSNumber]
    ) {
        browsing = "unavailable"
        sendStatus(lastError: (
            scope: "browse",
            code: "ERR_NSD_BROWSE",
            message: "didNotSearch \(errorDict)"
        ))
    }

    func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) {
        browsing = "active"
        sendStatus()
    }
}
