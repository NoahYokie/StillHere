import WatchKit
import Foundation

class ExtensionDelegate: NSObject, WKApplicationDelegate, URLSessionDownloadDelegate {
    private var pendingBackgroundTasks: [WKURLSessionRefreshBackgroundTask] = []
    private var backgroundSession: URLSession?

    func applicationDidFinishLaunching() {
        PhoneConnectivityManager.shared.activate()
        scheduleNextBackgroundRefresh()
    }

    func applicationDidBecomeActive() {
        SessionManager.shared.refreshStatusIfNeeded()
    }

    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            switch task {
            case let refreshTask as WKApplicationRefreshBackgroundTask:
                SessionManager.shared.refreshStatusIfNeeded()
                scheduleNextBackgroundRefresh()
                refreshTask.setTaskCompletedWithSnapshot(false)

            case let urlTask as WKURLSessionRefreshBackgroundTask:
                pendingBackgroundTasks.append(urlTask)
                let config = URLSessionConfiguration.background(
                    withIdentifier: urlTask.sessionIdentifier
                )
                backgroundSession = URLSession(
                    configuration: config,
                    delegate: self,
                    delegateQueue: nil
                )

            default:
                task.setTaskCompletedWithSnapshot(false)
            }
        }
    }

    func scheduleNextBackgroundRefresh() {
        let fireDate = Date().addingTimeInterval(15 * 60)
        WKExtension.shared().scheduleBackgroundRefresh(
            withPreferredDate: fireDate,
            userInfo: nil
        ) { error in
            if let error = error {
                print("[Watch] Failed to schedule background refresh: \(error)")
            }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        if let data = try? Data(contentsOf: location),
           let response = try? JSONDecoder().decode(QuickCheckinResponse.self, from: data) {
            DispatchQueue.main.async {
                SessionManager.shared.handleCheckinResponse(response)
            }
        }
        completePendingTasks()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil {
            completePendingTasks()
        }
    }

    private func completePendingTasks() {
        for task in pendingBackgroundTasks {
            task.setTaskCompletedWithSnapshot(false)
        }
        pendingBackgroundTasks.removeAll()
    }
}
