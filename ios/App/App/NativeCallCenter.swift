import Foundation
import Capacitor
import PushKit
import CallKit
import AVFoundation

final class NativeCallCenter: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = NativeCallCenter()

    weak var plugin: CAPPlugin?

    private var pushRegistry: PKPushRegistry?
    private var provider: CXProvider?
    private var currentToken: String?
    private var callPayloads: [UUID: [String: Any]] = [:]

    private override init() {
        super.init()
    }

    func configure() {
        if provider == nil {
            let config = CXProviderConfiguration(localizedName: "StillHere Safety")
            config.supportsVideo = false
            config.maximumCallsPerCallGroup = 1
            config.supportedHandleTypes = [.generic]
            config.includesCallsInRecents = false
            provider = CXProvider(configuration: config)
            provider?.setDelegate(self, queue: nil)
        }
        startVoipRegistration()
    }

    func startVoipRegistration() {
        if pushRegistry == nil {
            let registry = PKPushRegistry(queue: DispatchQueue.main)
            registry.delegate = self
            registry.desiredPushTypes = [.voIP]
            pushRegistry = registry
        }
        if let token = currentToken {
            emitRegistration(token)
        }
    }

    func endCall(id: String) {
        guard let uuid = UUID(uuidString: id) ?? uuidFromCompositeId(id) else { return }
        provider?.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        callPayloads.removeValue(forKey: uuid)
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        currentToken = token
        emitRegistration(token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        currentToken = nil
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else {
            completion()
            return
        }
        reportIncomingCall(payload.dictionaryPayload, completion: completion)
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        reportIncomingCall(payload.dictionaryPayload, completion: {})
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let payload = callPayloads[action.callUUID] ?? [:]
        let callId = stringValue(payload["callId"]) ?? action.callUUID.uuidString
        let callerId = stringValue(payload["callerId"]) ?? ""
        plugin?.notifyListeners("callAnswered", data: [
            "id": "\(callId)|\(callerId)",
            "callId": callId,
            "callerId": callerId
        ], retainUntilConsumed: true)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let payload = callPayloads[action.callUUID] ?? [:]
        let callId = stringValue(payload["callId"]) ?? action.callUUID.uuidString
        callPayloads.removeValue(forKey: action.callUUID)
        plugin?.notifyListeners("callEnded", data: [
            "id": callId,
            "callId": callId
        ], retainUntilConsumed: true)
        action.fulfill()
    }

    func providerDidReset(_ provider: CXProvider) {
        callPayloads.removeAll()
    }

    private func reportIncomingCall(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
        configure()

        let callId = stringValue(payload["callId"]) ?? stringValue(payload["uuid"]) ?? UUID().uuidString
        let uuid = UUID(uuidString: stringValue(payload["uuid"]) ?? callId) ?? UUID()
        let callerId = stringValue(payload["callerId"]) ?? ""
        let callerName = stringValue(payload["callerName"]) ?? stringValue(payload["handle"]) ?? "StillHere"

        callPayloads[uuid] = [
            "callId": callId,
            "callerId": callerId,
            "callerName": callerName
        ]

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false

        provider?.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error = error {
                NSLog("[NativeCall] Failed to report incoming CallKit call: \(error.localizedDescription)")
                self?.plugin?.notifyListeners("callEnded", data: [
                    "id": callId,
                    "callId": callId,
                    "error": error.localizedDescription
                ], retainUntilConsumed: true)
            }
            completion()
        }
    }

    private func emitRegistration(_ token: String) {
        plugin?.notifyListeners("registration", data: ["value": token], retainUntilConsumed: true)
    }

    private func uuidFromCompositeId(_ id: String) -> UUID? {
        return UUID(uuidString: id.components(separatedBy: "|").first ?? "")
    }

    private func stringValue(_ value: Any?) -> String? {
        if let value = value as? String, !value.isEmpty { return value }
        if let value = value as? CustomStringConvertible { return value.description }
        return nil
    }
}
