import Foundation
import WatchConnectivity

@MainActor
class PhoneConnectivityManager: NSObject, ObservableObject {
    static let shared = PhoneConnectivityManager()

    @Published var isPhoneReachable = false
    @Published var isPaired = false

    private var session: WCSession?

    override init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        session = WCSession.default
        session?.delegate = self
        session?.activate()
    }

    func sendCheckin() {
        guard let session = session, session.isReachable else {
            Task { await SessionManager.shared.performCheckin() }
            return
        }

        session.sendMessage(["action": "checkin"], replyHandler: { reply in
            if let ok = reply["ok"] as? Bool, ok {
                DispatchQueue.main.async {
                    SessionManager.shared.checkinSuccess = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                        SessionManager.shared.checkinSuccess = false
                    }
                }
            }
        }, errorHandler: { error in
            print("[Watch] WC checkin failed: \(error), falling back to HTTP")
            Task { @MainActor in
                await SessionManager.shared.performCheckin()
            }
        })
    }

    func sendSOS() {
        guard let session = session, session.isReachable else {
            Task { await SessionManager.shared.triggerSOS() }
            return
        }

        session.sendMessage(["action": "sos"], replyHandler: { reply in
            if let ok = reply["ok"] as? Bool, ok {
                DispatchQueue.main.async {
                    SessionManager.shared.sosActive = true
                }
            }
        }, errorHandler: { error in
            print("[Watch] WC SOS failed: \(error), falling back to HTTP")
            Task { @MainActor in
                await SessionManager.shared.triggerSOS()
            }
        })
    }
}

extension PhoneConnectivityManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isPaired = session.isPaired
            self.isPhoneReachable = session.isReachable
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isPhoneReachable = session.isReachable
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let token = message["authToken"] as? String {
            DispatchQueue.main.async {
                SessionManager.shared.setToken(token)
            }
        }

        if let baseURL = message["baseURL"] as? String {
            DispatchQueue.main.async {
                SessionManager.shared.setBaseURL(baseURL)
            }
        }

        if let action = message["action"] as? String {
            switch action {
            case "logout":
                DispatchQueue.main.async {
                    SessionManager.shared.logout()
                }
            case "statusUpdate":
                DispatchQueue.main.async {
                    SessionManager.shared.refreshStatusIfNeeded()
                }
            default:
                break
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let token = applicationContext["authToken"] as? String {
            DispatchQueue.main.async {
                SessionManager.shared.setToken(token)
            }
        }
        if let baseURL = applicationContext["baseURL"] as? String {
            DispatchQueue.main.async {
                SessionManager.shared.setBaseURL(baseURL)
            }
        }
    }
}
