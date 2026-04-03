import Foundation
import CoreMotion
import WatchKit
import Combine

class FallDetectionService: ObservableObject {
    static let shared = FallDetectionService()

    @Published var isEnabled = true
    @Published var state: FallDetectionState = .monitoring
    @Published var countdownSeconds: Int = 60
    @Published var isAvailable = false

    private let motionManager = CMMotionManager()
    private let motionQueue = OperationQueue()
    private var countdownTimer: Timer?

    private let processingLock = NSLock()
    private var internalState: FallDetectionState = .monitoring
    private var impactDetected = false
    private var impactTimestamp: TimeInterval = 0
    private var preImpactMagnitudes: [Double] = []
    private var postImpactSamples: [(magnitude: Double, rotRate: Double, timestamp: TimeInterval)] = []
    private var cooldownActive = false
    private var countdownTriggered = false

    private let impactThresholdG: Double = 3.0
    private let hardImpactThresholdG: Double = 6.0
    private let freefallThresholdG: Double = 0.3
    private let stillnessThresholdG: Double = 0.15
    private let rotationThresholdDPS: Double = 200.0
    private let postImpactWindowSec: Double = 3.0
    private let preImpactWindowSamples = 25
    private let requiredStillnessRatio: Double = 0.6
    private let cooldownDurationSec: Double = 120.0
    private let countdownDuration = 60
    private let sensorUpdateInterval: TimeInterval = 1.0 / 50.0

    private init() {
        motionQueue.name = "com.stillhere.falldetection"
        motionQueue.maxConcurrentOperationCount = 1
        isAvailable = motionManager.isDeviceMotionAvailable
    }

    func startMonitoring() {
        guard isAvailable, !motionManager.isDeviceMotionActive else { return }

        motionManager.deviceMotionUpdateInterval = sensorUpdateInterval
        motionManager.startDeviceMotionUpdates(
            using: .xArbitraryZVertical,
            to: motionQueue
        ) { [weak self] motion, error in
            guard let self = self, let motion = motion, error == nil else { return }
            self.processMotion(motion)
        }

        updateState(.monitoring)
    }

    func stopMonitoring() {
        motionManager.stopDeviceMotionUpdates()
        processingLock.lock()
        resetDetectionLocked()
        processingLock.unlock()
        updateState(.monitoring)
    }

    func cancelAlert() {
        DispatchQueue.main.async {
            self.countdownTimer?.invalidate()
            self.countdownTimer = nil
        }
        processingLock.lock()
        resetDetectionLocked()
        processingLock.unlock()
        WKInterfaceDevice.current().play(.stop)
        updateState(.cancelled)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.updateState(.monitoring)
        }
    }

    func confirmSOS() {
        DispatchQueue.main.async {
            self.countdownTimer?.invalidate()
            self.countdownTimer = nil
        }
        WKInterfaceDevice.current().play(.notification)
        updateState(.sosTriggered)
        Task { @MainActor in
            await SessionManager.shared.triggerSOS()
        }
        activateCooldown()
    }

    private func processMotion(_ motion: CMDeviceMotion) {
        processingLock.lock()
        defer { processingLock.unlock() }

        guard !cooldownActive, !countdownTriggered else { return }

        let userAcc = motion.userAcceleration
        let accMagnitude = sqrt(
            userAcc.x * userAcc.x +
            userAcc.y * userAcc.y +
            userAcc.z * userAcc.z
        )

        let rotRate = motion.rotationRate
        let rotMagnitude = sqrt(
            rotRate.x * rotRate.x +
            rotRate.y * rotRate.y +
            rotRate.z * rotRate.z
        ) * (180.0 / .pi)

        if !impactDetected {
            preImpactMagnitudes.append(accMagnitude)
            if preImpactMagnitudes.count > preImpactWindowSamples {
                preImpactMagnitudes.removeFirst()
            }

            let hasFreefallPhase = preImpactMagnitudes.contains { $0 < freefallThresholdG }

            if accMagnitude >= impactThresholdG {
                let isHardImpact = accMagnitude >= hardImpactThresholdG
                let hasSignificantRotation = rotMagnitude >= rotationThresholdDPS

                let confidenceScore = calculateImpactConfidence(
                    magnitude: accMagnitude,
                    isHardImpact: isHardImpact,
                    hadFreefall: hasFreefallPhase,
                    hasRotation: hasSignificantRotation
                )

                if confidenceScore >= 0.5 {
                    impactDetected = true
                    impactTimestamp = motion.timestamp
                    postImpactSamples.removeAll()

                    updateState(.impactDetected)
                    WKInterfaceDevice.current().play(.click)
                }
            }
        } else {
            let timeSinceImpact = motion.timestamp - impactTimestamp

            postImpactSamples.append((
                magnitude: accMagnitude,
                rotRate: rotMagnitude,
                timestamp: motion.timestamp
            ))

            if timeSinceImpact > postImpactWindowSec {
                let totalSamples = postImpactSamples.count
                let stillSamples = postImpactSamples.filter {
                    $0.magnitude < stillnessThresholdG && $0.rotRate < 10.0
                }.count

                let stillnessRatio = totalSamples > 0 ? Double(stillSamples) / Double(totalSamples) : 0.0

                if stillnessRatio >= requiredStillnessRatio {
                    countdownTriggered = true
                    DispatchQueue.main.async { [weak self] in
                        self?.triggerFallCountdown()
                    }
                } else {
                    resetDetectionLocked()
                    updateState(.monitoring)
                }
            }
        }
    }

    private func calculateImpactConfidence(
        magnitude: Double,
        isHardImpact: Bool,
        hadFreefall: Bool,
        hasRotation: Bool
    ) -> Double {
        var score: Double = 0.0

        if magnitude >= hardImpactThresholdG {
            score += 0.4
        } else if magnitude >= impactThresholdG {
            score += 0.25
        }

        if hadFreefall {
            score += 0.3
        }

        if hasRotation {
            score += 0.2
        }

        if isHardImpact && hadFreefall {
            score += 0.1
        }

        return min(score, 1.0)
    }

    private func triggerFallCountdown() {
        countdownSeconds = countdownDuration
        updateState(.countdown(secondsRemaining: countdownDuration))
        WKInterfaceDevice.current().play(.notification)

        countdownTimer?.invalidate()
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            guard let self = self else {
                timer.invalidate()
                return
            }

            self.countdownSeconds -= 1

            if self.countdownSeconds % 10 == 0 && self.countdownSeconds > 0 {
                WKInterfaceDevice.current().play(.notification)
            }

            self.updateState(.countdown(secondsRemaining: self.countdownSeconds))

            if self.countdownSeconds <= 0 {
                timer.invalidate()
                self.confirmSOS()
            }
        }
    }

    private func resetDetectionLocked() {
        impactDetected = false
        impactTimestamp = 0
        countdownTriggered = false
        preImpactMagnitudes.removeAll()
        postImpactSamples.removeAll()
    }

    private func activateCooldown() {
        processingLock.lock()
        cooldownActive = true
        resetDetectionLocked()
        processingLock.unlock()

        DispatchQueue.main.asyncAfter(deadline: .now() + cooldownDurationSec) { [weak self] in
            guard let self = self else { return }
            self.processingLock.lock()
            self.cooldownActive = false
            self.processingLock.unlock()
            self.updateState(.monitoring)
        }
    }

    private func updateState(_ newState: FallDetectionState) {
        DispatchQueue.main.async { [weak self] in
            self?.state = newState
        }
    }
}
