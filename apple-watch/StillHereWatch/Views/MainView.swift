import SwiftUI
import WatchKit

struct MainView: View {
    @EnvironmentObject var sessionManager: SessionManager
    @EnvironmentObject var fallDetection: FallDetectionService
    @EnvironmentObject var heartRate: HeartRateService
    @State private var showSOS = false

    var body: some View {
        NavigationStack {
            ZStack {
                if case .countdown(let seconds) = fallDetection.state {
                    FallCountdownView(seconds: seconds)
                } else if fallDetection.state == .sosTriggered || sessionManager.sosActive {
                    SOSActiveView()
                } else {
                    checkinView
                }
            }
            .onAppear {
                sessionManager.refreshStatusIfNeeded()
                if fallDetection.isEnabled && fallDetection.isAvailable {
                    fallDetection.startMonitoring()
                }
                Task {
                    if heartRate.isAvailable {
                        let authorized = await heartRate.requestAuthorization()
                        if authorized {
                            heartRate.startMonitoring()
                        }
                    }
                }
            }
        }
    }

    private var checkinView: some View {
        ScrollView {
            VStack(spacing: 10) {
                statusHeader

                checkinButton

                heartRateDisplay

                if !sessionManager.status.userName.isEmpty {
                    nextDueInfo
                }

                sosButton
            }
            .padding(.horizontal, 4)
            .padding(.top, 4)
        }
    }

    private var statusHeader: some View {
        HStack {
            Image(systemName: "heart.fill")
                .foregroundColor(.cyan)
                .font(.system(size: 12))
            Text("StillHere")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.cyan)
            Spacer()
            HStack(spacing: 4) {
                if heartRate.isMonitoring {
                    Image(systemName: "heart.fill")
                        .foregroundColor(.red)
                        .font(.system(size: 9))
                        .symbolEffect(.pulse)
                }
                if fallDetection.isEnabled && fallDetection.isAvailable {
                    Image(systemName: "figure.fall")
                        .foregroundColor(.green)
                        .font(.system(size: 10))
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private var checkinButton: some View {
        Button(action: {
            WKInterfaceDevice.current().play(.click)
            Task { await sessionManager.performCheckin() }
        }) {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(sessionManager.checkinSuccess ? Color.green : Color.green.opacity(0.85))
                        .frame(width: 72, height: 72)
                        .shadow(color: .green.opacity(0.3), radius: 8)

                    if sessionManager.isLoading {
                        ProgressView()
                            .tint(.white)
                    } else if sessionManager.checkinSuccess {
                        Image(systemName: "checkmark")
                            .font(.system(size: 32, weight: .bold))
                            .foregroundColor(.white)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundColor(.white)
                    }
                }

                Text(sessionManager.checkinSuccess ? "You're OK!" : "I'm OK")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(sessionManager.checkinSuccess ? .green : .primary)
            }
        }
        .buttonStyle(.plain)
        .disabled(sessionManager.isLoading)
    }

    private var heartRateDisplay: some View {
        Group {
            if heartRate.currentBPM > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "heart.fill")
                        .foregroundColor(heartRateColor)
                        .font(.system(size: 12))
                        .symbolEffect(.pulse)

                    Text("\(heartRate.currentBPM)")
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundColor(heartRateColor)
                        .monospacedDigit()

                    Text("BPM")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 12)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(heartRateColor.opacity(0.15))
                )
            } else if heartRate.isMonitoring {
                HStack(spacing: 4) {
                    ProgressView()
                        .tint(.red)
                        .scaleEffect(0.6)
                    Text("Reading heart rate...")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    private var heartRateColor: Color {
        if let alert = heartRate.alertActive {
            return alert == "high" ? .orange : .blue
        }
        return .red
    }

    private var nextDueInfo: some View {
        VStack(spacing: 2) {
            if sessionManager.status.isOverdue {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                        .font(.system(size: 10))
                    Text("Overdue")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.orange)
                }
            } else if let nextDue = sessionManager.status.nextDueTime {
                Text("Next checkin")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                Text(nextDue, style: .relative)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.secondary)
            }
        }
    }

    private var sosButton: some View {
        Button(action: {
            showSOS = true
        }) {
            HStack(spacing: 4) {
                Image(systemName: "sos")
                    .font(.system(size: 10, weight: .bold))
                Text("I Need Help")
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Color.red)
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
        .confirmationDialog("Send SOS Alert?", isPresented: $showSOS) {
            Button("Send SOS", role: .destructive) {
                WKInterfaceDevice.current().play(.notification)
                Task { await sessionManager.triggerSOS() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will immediately notify all your emergency contacts.")
        }
    }
}
