import SwiftUI
import WatchKit

struct FallCountdownView: View {
    let seconds: Int
    @EnvironmentObject var fallDetection: FallDetectionService

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "figure.fall")
                .font(.system(size: 28))
                .foregroundColor(.orange)

            Text("Fall Detected")
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(.orange)

            Text("\(seconds)")
                .font(.system(size: 44, weight: .heavy, design: .rounded))
                .foregroundColor(.white)
                .monospacedDigit()

            Text("seconds")
                .font(.system(size: 11))
                .foregroundColor(.secondary)

            Text("SOS will send automatically")
                .font(.system(size: 10))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            HStack(spacing: 8) {
                Button(action: {
                    fallDetection.cancelAlert()
                }) {
                    Text("I'm OK")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color.green)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)

                Button(action: {
                    fallDetection.confirmSOS()
                }) {
                    Text("SOS Now")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color.red)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
    }
}
