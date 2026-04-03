import SwiftUI

struct PairingView: View {
    @EnvironmentObject var connectivityManager: PhoneConnectivityManager
    @EnvironmentObject var sessionManager: SessionManager

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "heart.fill")
                .font(.system(size: 28))
                .foregroundColor(.cyan)

            Text("StillHere")
                .font(.system(size: 18, weight: .bold))

            Divider()
                .padding(.horizontal)

            if connectivityManager.isPaired {
                VStack(spacing: 6) {
                    Image(systemName: "iphone.and.arrow.forward")
                        .font(.system(size: 20))
                        .foregroundColor(.secondary)

                    Text("Open StillHere on your iPhone to connect")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)

                    if connectivityManager.isPhoneReachable {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(.green)
                                .frame(width: 6, height: 6)
                            Text("Phone connected")
                                .font(.system(size: 10))
                                .foregroundColor(.green)
                        }
                        .padding(.top, 4)
                    }
                }
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "applewatch.slash")
                        .font(.system(size: 20))
                        .foregroundColor(.orange)

                    Text("Pair your Apple Watch with iPhone first")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .padding()
    }
}
