import Foundation
import UIKit

class AppState: ObservableObject {
    @Published var questions: [Question] = Question.allQuestions
    @Published var currentQuestionIndex: Int = 0
    @Published var lightStatus: AnswerType = .none
    @Published var denialCount: Int = 0
    @Published var isCompleted: Bool = false
    @Published var showDenialAlert: Bool = false

    private let logger = LoggerService.shared

    func answerQuestion(with type: AnswerType) {
        questions[currentQuestionIndex].answer = type
        updateLightStatus()

        if type == .red {
            denialCount += 1
            logger.log(event: "denial", questionId: questions[currentQuestionIndex].id)
            showDenialAlert = true
            return
        }

        if currentQuestionIndex < questions.count - 1 {
            currentQuestionIndex += 1
        } else {
            completeChecklist()
        }
    }

    func updateLightStatus() {
        let answers = questions.map { $0.answer }

        if answers.allSatisfy({ $0 == .none }) {
            lightStatus = .none
        } else if answers.contains(.red) {
            lightStatus = .red
        } else if answers.contains(.yellow) {
            lightStatus = .yellow
        } else if answers.allSatisfy({ $0 == .green }) {
            lightStatus = .green
        }
    }

    func completeChecklist() {
        isCompleted = true
        lightStatus = .green
        logger.log(event: "completed", questionId: 0)
        openMatchTrader()
    }

    func openMatchTrader() {
        // Try custom URL schemes first
        let schemes = ["matchtrader://", "match-trader://", "mttrader://"]

        for scheme in schemes {
            if let url = URL(string: scheme) {
                if UIApplication.shared.canOpenURL(url) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        UIApplication.shared.open(url, options: [:], completionHandler: nil)
                    }
                    return
                }
            }
        }

        // Fallback to App Store if app not installed
        if let url = URL(string: "itms-apps://apps.apple.com/app/id1542334322") {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    func resetChecklist() {
        isCompleted = false
        currentQuestionIndex = 0
        questions = Question.allQuestions
        lightStatus = .none
    }

    func resetForNewDay() {
        let calendar = Calendar.current
        let lastResetDate = UserDefaults.standard.object(forKey: "lastResetDate") as? Date ?? Date.distantPast

        if !calendar.isDateInToday(lastResetDate) {
            denialCount = 0
            UserDefaults.standard.set(Date(), forKey: "lastResetDate")
        }
    }
}
