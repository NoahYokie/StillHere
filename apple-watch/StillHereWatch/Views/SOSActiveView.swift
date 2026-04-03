import SwiftUI

struct SOSActiveView: View {
    @EnvironmentObject var sessionManager: SessionManager

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "sos")
                .font(.system(size: 36, weight: .bold))
                .foregroundColor(.red)
                .symbolEffect(.pulse)

            Text("Help Requested")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.red)

            Text("Your emergency contacts have been notified")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            Spacer()

            Button(action: {
                sessionManager.refreshStatusIfNeeded()
            }) {
                Text("Refresh Status")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.cyan)
            }
        }
        .padding()
    }
}
