import Foundation

class LoggerService {
    static let shared = LoggerService()

    private let userDefaults = UserDefaults.standard
    private let logKey = "trading_checklist_log"

    func log(event: String, questionId: Int) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let logEntry = [
            "timestamp": timestamp,
            "event": event,
            "questionId": questionId
        ] as [String: Any]

        var logs = userDefaults.array(forKey: logKey) as? [[String: Any]] ?? []
        logs.append(logEntry)
        userDefaults.set(logs, forKey: logKey)
    }

    func getLogs() -> [[String: Any]] {
        return userDefaults.array(forKey: logKey) as? [[String: Any]] ?? []
    }

    func clearLogs() {
        userDefaults.removeObject(forKey: logKey)
    }
}
