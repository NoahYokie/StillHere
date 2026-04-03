import Foundation

struct QuickCheckinResponse: Codable {
    let ok: Bool
    let checkinId: String?
    let at: String?
}

struct SimpleStatusResponse: Codable {
    let ok: Bool
    let name: String?
    let lastCheckin: String?
    let nextDue: String?
    let isOverdue: Bool?
    let hasActiveIncident: Bool?
}

struct SOSResponse: Codable {
    let success: Bool?
    let alreadyActive: Bool?
}

struct WatchStatus {
    var userName: String
    var lastCheckinTime: Date?
    var nextDueTime: Date?
    var isOverdue: Bool
    var hasActiveIncident: Bool
    var lastRefreshed: Date?

    static let empty = WatchStatus(
        userName: "",
        lastCheckinTime: nil,
        nextDueTime: nil,
        isOverdue: false,
        hasActiveIncident: false,
        lastRefreshed: nil
    )
}

enum FallDetectionState: Equatable {
    case monitoring
    case impactDetected
    case countdown(secondsRemaining: Int)
    case sosTriggered
    case cancelled
}
