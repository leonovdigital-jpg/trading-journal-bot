import SwiftUI

class ChecklistViewModel: ObservableObject {
  @Published var currentQuestionIndex = 0
  @Published var lampStatus = LampStatus.waiting
  @Published var isSuccess = false
  @Published var rejectCount = 0
  @Published var answers: [String] = []

  let questions: [Question] = [
    Question(
      text: "Закрепы против отсутствуют?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true),
        Button(label: "Есть на часе", value: "hour", color: "yellow", blocking: false)
      ]
    ),
    Question(
      text: "Импульсного пролива нет?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true)
      ]
    ),
    Question(
      text: "СМТ все чисто?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true)
      ]
    ),
    Question(
      text: "До 2х стопов за сегодня?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true)
      ]
    ),
    Question(
      text: "Готов получить стопа за эту идею?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true)
      ]
    ),
    Question(
      text: "5м модель есть, не спешим, лучше лимиткой на тесте?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true)
      ]
    ),
    Question(
      text: "ВПН ВЫКЛЮЧИЛ?",
      buttons: [
        Button(label: "Да", value: "yes", color: "green", blocking: false),
        Button(label: "Нет", value: "no", color: "red", blocking: true)
      ],
      isVpnQuestion: true
    )
  ]

  init() {
    loadStats()
  }

  func answer(_ value: String, _ isBlocking: Bool) {
    answers.append(value)

    if isBlocking {
      reject()
    } else {
      if currentQuestionIndex < questions.count - 1 {
        currentQuestionIndex += 1
      } else {
        allow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
          self.openMatchTrader()
        }
      }
    }
  }

  func reject() {
    lampStatus = .error
    isSuccess = false
    logChecklist(result: "rejected")
    updateStats()
  }

  func allow() {
    lampStatus = .success
    isSuccess = true
    logChecklist(result: "allowed")
    openMatchTrader()
  }

  func logChecklist(result: String) {
    let today = Date().toDateString()
    var logs = UserDefaults.standard.array(forKey: "checklistLogs") as? [[String: Any]] ?? []

    let log: [String: Any] = [
      "timestamp": Date().ISO8601Format(),
      "date": today,
      "answers": answers,
      "result": result
    ]

    logs.append(log)
    UserDefaults.standard.set(logs, forKey: "checklistLogs")
  }

  func updateStats() {
    let today = Date().toDateString()
    let logs = UserDefaults.standard.array(forKey: "checklistLogs") as? [[String: Any]] ?? []

    let todayLogs = logs.filter { ($0["date"] as? String) == today }
    rejectCount = todayLogs.filter { ($0["result"] as? String) == "rejected" }.count
  }

  func loadStats() {
    updateStats()
  }

  func openMatchTrader() {
    if let url = URL(string: "matchtrader://") {
      if UIApplication.shared.canOpenURL(url) {
        UIApplication.shared.open(url)
      }
    }
  }
}

struct Question {
  let text: String
  let buttons: [Button]
  var isVpnQuestion: Bool = false
}

struct Button {
  let label: String
  let value: String
  let color: String
  let blocking: Bool
}

enum LampStatus {
  case waiting
  case success
  case error

  var color: Color {
    switch self {
    case .waiting:
      return Color(red: 1, green: 0.72, blue: 0.3)
    case .success:
      return Color.green
    case .error:
      return Color.red
    }
  }

  var shadowColor: Color {
    switch self {
    case .waiting:
      return Color(red: 1, green: 0.72, blue: 0.3).opacity(0.6)
    case .success:
      return Color.green.opacity(0.6)
    case .error:
      return Color.red.opacity(0.6)
    }
  }
}

extension Date {
  func toDateString() -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: self)
  }
}
