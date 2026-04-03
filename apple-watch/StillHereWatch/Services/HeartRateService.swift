import Foundation
import HealthKit
import WatchKit

@MainActor
class HeartRateService: ObservableObject {
    static let shared = HeartRateService()

    @Published var currentBPM: Int = 0
    @Published var isMonitoring = false
    @Published var isAuthorized = false
    @Published var lastSyncedAt: Date?
    @Published var alertActive: String?

    private let healthStore = HKHealthStore()
    private var workoutSession: HKWorkoutSession?
    private var workoutBuilder: HKLiveWorkoutBuilder?
    private var anchoredQuery: HKAnchoredObjectQuery?
    private var queryAnchor: HKQueryAnchor?
    private var pendingReadings: [(bpm: Int, recordedAt: Date)] = []
    private var syncTimer: Timer?
    private var isSyncing = false

    private let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate)!
    private let syncIntervalSec: TimeInterval = 5 * 60
    private let highBPMThreshold = 120
    private let lowBPMThreshold = 40
    private let maxPendingReadings = 100

    private init() {}

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization() async -> Bool {
        guard isAvailable else { return false }

        let typesToRead: Set<HKObjectType> = [heartRateType]
        let typesToWrite: Set<HKSampleType> = [
            HKQuantityType.workoutType()
        ]

        do {
            try await healthStore.requestAuthorization(toShare: typesToWrite, read: typesToRead)
            let status = healthStore.authorizationStatus(for: heartRateType)
            isAuthorized = status == .sharingAuthorized
            return isAuthorized
        } catch {
            print("[HeartRate] Authorization failed: \(error)")
            isAuthorized = false
            return false
        }
    }

    func startMonitoring() {
        guard isAvailable, isAuthorized, !isMonitoring else { return }

        startWorkoutSession()
    }

    func stopMonitoring() {
        stopWorkoutSession()
        if let query = anchoredQuery {
            healthStore.stop(query)
            anchoredQuery = nil
        }
        syncTimer?.invalidate()
        syncTimer = nil
        syncPendingReadings()
        isMonitoring = false
    }

    private func startWorkoutSession() {
        let config = HKWorkoutConfiguration()
        config.activityType = .other
        config.locationType = .unknown

        do {
            workoutSession = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            workoutBuilder = workoutSession?.associatedWorkoutBuilder()

            workoutBuilder?.dataSource = HKLiveWorkoutDataSource(
                healthStore: healthStore,
                workoutConfiguration: config
            )

            workoutSession?.startActivity(with: Date())
            try workoutBuilder?.beginCollection(withStart: Date()) { [weak self] success, error in
                guard success, error == nil else {
                    print("[HeartRate] Failed to begin collection: \(error?.localizedDescription ?? "unknown")")
                    return
                }
                DispatchQueue.main.async {
                    self?.isMonitoring = true
                    self?.startHeartRateQuery()
                    self?.startSyncTimer()
                }
            }
        } catch {
            print("[HeartRate] Failed to start workout session: \(error)")
        }
    }

    private func stopWorkoutSession() {
        workoutSession?.end()
        workoutBuilder?.endCollection(withEnd: Date()) { [weak self] _, _ in
            self?.workoutBuilder?.finishWorkout { _, _ in }
        }
        workoutSession = nil
        workoutBuilder = nil
    }

    private func startHeartRateQuery() {
        let predicate = HKQuery.predicateForSamples(
            withStart: Date(),
            end: nil,
            options: .strictStartDate
        )

        let query = HKAnchoredObjectQuery(
            type: heartRateType,
            predicate: predicate,
            anchor: queryAnchor,
            limit: HKObjectQueryNoLimit
        ) { [weak self] _, samples, _, newAnchor, error in
            guard error == nil else { return }
            self?.queryAnchor = newAnchor
            self?.processSamples(samples)
        }

        query.updateHandler = { [weak self] _, samples, _, newAnchor, error in
            guard error == nil else { return }
            self?.queryAnchor = newAnchor
            self?.processSamples(samples)
        }

        healthStore.execute(query)
        anchoredQuery = query
    }

    private func processSamples(_ samples: [HKSample]?) {
        guard let heartRateSamples = samples as? [HKQuantitySample] else { return }

        let unit = HKUnit.count().unitDivided(by: .minute())

        for sample in heartRateSamples {
            let bpm = Int(sample.quantity.doubleValue(for: unit))
            let recordedAt = sample.startDate

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.currentBPM = bpm
                self.pendingReadings.append((bpm: bpm, recordedAt: recordedAt))

                if self.pendingReadings.count > self.maxPendingReadings {
                    self.pendingReadings.removeFirst(self.pendingReadings.count - self.maxPendingReadings)
                }

                if bpm > self.highBPMThreshold {
                    self.alertActive = "high"
                    WKInterfaceDevice.current().play(.notification)
                } else if bpm < self.lowBPMThreshold {
                    self.alertActive = "low"
                    WKInterfaceDevice.current().play(.notification)
                } else {
                    self.alertActive = nil
                }
            }
        }
    }

    private func startSyncTimer() {
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: syncIntervalSec, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                self?.syncPendingReadings()
            }
        }
    }

    func syncPendingReadings() {
        guard !pendingReadings.isEmpty, !isSyncing else { return }

        isSyncing = true
        let toSync = Array(pendingReadings)

        Task {
            let success = await uploadReadings(toSync)
            DispatchQueue.main.async {
                if success {
                    self.pendingReadings.removeAll(where: { reading in
                        toSync.contains(where: { $0.recordedAt == reading.recordedAt && $0.bpm == reading.bpm })
                    })
                }
                self.isSyncing = false
            }
        }
    }

    private func uploadReadings(_ readings: [(bpm: Int, recordedAt: Date)]) async -> Bool {
        let token = SessionManager.shared.authToken
        guard !token.isEmpty else { return false }

        let baseURL = SessionManager.shared.baseURL
        guard let url = URL(string: "\(baseURL)/api/heartrate") else { return false }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let payload: [[String: Any]] = readings.map { r in
            [
                "bpm": r.bpm,
                "recordedAt": formatter.string(from: r.recordedAt),
                "source": "watch",
            ]
        }

        let body: [String: Any] = ["readings": payload]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData
        request.timeoutInterval = 15

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                if httpResponse.statusCode == 401 {
                    DispatchQueue.main.async {
                        SessionManager.shared.logout()
                    }
                    return false
                }
                if httpResponse.statusCode == 200 {
                    DispatchQueue.main.async {
                        self.lastSyncedAt = Date()
                    }
                    return true
                }
            }
            return false
        } catch {
            return false
        }
    }

    func fetchLatestFromServer() async -> (bpm: Int, alertType: String?)? {
        let token = SessionManager.shared.authToken
        guard !token.isEmpty else { return nil }

        let baseURL = SessionManager.shared.baseURL
        guard let url = URL(string: "\(baseURL)/api/heartrate/latest") else { return nil }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else { return nil }

            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let heartRate = json["heartRate"] as? [String: Any],
               let bpm = heartRate["bpm"] as? Int {
                let alerts = json["alerts"] as? [[String: Any]]
                let alertType = alerts?.first?["type"] as? String
                return (bpm: bpm, alertType: alertType)
            }
        } catch {
            print("[HeartRate] Fetch failed: \(error)")
        }
        return nil
    }
}
