import SwiftUI
import WatchKit

@main
struct StillHereWatchApp: App {
    @WKApplicationDelegateAdaptor(ExtensionDelegate.self) var delegate
    @StateObject private var sessionManager = SessionManager.shared
    @StateObject private var fallDetectionService = FallDetectionService.shared
    @StateObject private var connectivityManager = PhoneConnectivityManager.shared

    var body: some Scene {
        WindowGroup {
            if sessionManager.isAuthenticated {
                MainView()
                    .environmentObject(sessionManager)
                    .environmentObject(fallDetectionService)
                    .environmentObject(connectivityManager)
            } else {
                PairingView()
                    .environmentObject(sessionManager)
                    .environmentObject(connectivityManager)
            }
        }
    }
}
