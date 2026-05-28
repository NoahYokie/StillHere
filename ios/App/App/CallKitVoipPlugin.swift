import Foundation
import Capacitor

@objc(CallKitVoipPlugin)
public class CallKitVoipPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CallKitVoipPlugin"
    public let jsName = "CallKitVoip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        NativeCallCenter.shared.plugin = self
        NativeCallCenter.shared.configure()
    }

    @objc func register(_ call: CAPPluginCall) {
        NativeCallCenter.shared.plugin = self
        NativeCallCenter.shared.startVoipRegistration()
        call.resolve()
    }

    @objc func endCall(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        NativeCallCenter.shared.endCall(id: id)
        call.resolve()
    }
}
