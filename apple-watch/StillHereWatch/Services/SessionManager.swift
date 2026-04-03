import Foundation
import WatchKit
import WidgetKit

@MainActor
class SessionManager: ObservableObject {
    static let shared = SessionManager()

    @Published var isAuthenticated = false
    @Published var authToken: String = ""
    @Published var status: WatchStatus = .empty
    @Published var isLoading = false
    @Published var checkinSuccess = false
    @Published var sosActive = false
    @Published var lastError: String?

    private let tokenKeychainKey = "stillhere_auth_token"
    private let baseURLKeychainKey = "stillhere_base_url"
    private let sharedDefaults = UserDefaults(suiteName: "group.com.stillhere.app")
    private static let allowedHosts = ["stillhere.health", "www.stillhere.health"]

    var baseURL: String {
        get { KeychainHelper.load(key: baseURLKeychainKey) ?? "https://stillhere.health" }
    }

    private init() {
        if let token = KeychainHelper.load(key: tokenKeychainKey), !token.isEmpty {
            authToken = token
            isAuthenticated = true
        }
    }

    func setToken(_ token: String) {
        authToken = token
        KeychainHelper.save(token, for: tokenKeychainKey)
        isAuthenticated = true
        refreshStatusIfNeeded()
    }

    func setBaseURL(_ url: String) {
        guard isAllowedBaseURL(url) else {
            print("[Watch] Rejected untrusted baseURL: \(url)")
            return
        }
        KeychainHelper.save(url, for: baseURLKeychainKey)
    }

    func logout() {
        authToken = ""
        KeychainHelper.delete(tokenKeychainKey)
        isAuthenticated = false
        status = .empty
    }

    func refreshStatusIfNeeded() {
        guard isAuthenticated else { return }
        Task { await fetchStatus() }
    }

    func fetchStatus() async {
        guard !authToken.isEmpty else { return }

        guard let url = URL(string: "\(baseURL)/api/status/simple") else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return }

            if httpResponse.statusCode == 401 {
                logout()
                return
            }

            guard httpResponse.statusCode == 200 else { return }

            let decoded = try JSONDecoder().decode(SimpleStatusResponse.self, from: data)

            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

            status = WatchStatus(
                userName: decoded.name ?? "",
                lastCheckinTime: decoded.lastCheckin.flatMap { formatter.date(from: $0) },
                nextDueTime: decoded.nextDue.flatMap { formatter.date(from: $0) },
                isOverdue: decoded.isOverdue ?? false,
                hasActiveIncident: decoded.hasActiveIncident ?? false,
                lastRefreshed: Date()
            )
            sosActive = decoded.hasActiveIncident ?? false
            lastError = nil
            updateComplicationData()
        } catch {
            lastError = "Connection failed"
        }
    }

    func performCheckin() async {
        guard !authToken.isEmpty else { return }
        isLoading = true
        checkinSuccess = false

        guard let url = URL(string: "\(baseURL)/api/checkin/quick") else {
            isLoading = false
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = "{}".data(using: .utf8)
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                isLoading = false
                return
            }

            if httpResponse.statusCode == 401 {
                logout()
                isLoading = false
                return
            }

            if httpResponse.statusCode == 200 {
                let decoded = try JSONDecoder().decode(QuickCheckinResponse.self, from: data)
                if decoded.ok {
                    checkinSuccess = true
                    WKInterfaceDevice.current().play(.success)
                    await fetchStatus()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                        self.checkinSuccess = false
                    }
                }
            }
            lastError = nil
        } catch {
            lastError = "Checkin failed"
            WKInterfaceDevice.current().play(.failure)
        }

        isLoading = false
    }

    func triggerSOS() async {
        guard !authToken.isEmpty else { return }
        isLoading = true

        guard let url = URL(string: "\(baseURL)/api/sos") else {
            isLoading = false
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = "{}".data(using: .utf8)
        request.timeoutInterval = 10

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                isLoading = false
                return
            }

            if httpResponse.statusCode == 401 {
                logout()
                isLoading = false
                return
            }

            if httpResponse.statusCode == 200 {
                sosActive = true
                WKInterfaceDevice.current().play(.notification)
            }
            lastError = nil
        } catch {
            lastError = "SOS failed"
            WKInterfaceDevice.current().play(.failure)
        }

        isLoading = false
        await fetchStatus()
    }

    func handleCheckinResponse(_ response: QuickCheckinResponse) {
        if response.ok {
            checkinSuccess = true
            WKInterfaceDevice.current().play(.success)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.checkinSuccess = false
            }
        }
    }

    private func updateComplicationData() {
        sharedDefaults?.set(status.isOverdue, forKey: "complication_isOverdue")
        sharedDefaults?.set(status.hasActiveIncident, forKey: "complication_hasIncident")
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func isAllowedBaseURL(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString),
              let scheme = url.scheme,
              scheme == "https",
              let host = url.host else {
            return false
        }
        return Self.allowedHosts.contains(host) || host.hasSuffix(".replit.app") || host.hasSuffix(".replit.dev")
    }
}
