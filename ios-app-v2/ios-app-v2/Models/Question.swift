import Foundation

enum AnswerType {
    case green    // Проход
    case yellow   // Проход с предупреждением
    case red      // Блокировка
    case none     // Не отвечено
}

struct Question {
    let id: Int
    let text: String
    let isVpnQuestion: Bool // true для 7-го вопроса
    var answer: AnswerType = .none

    static let allQuestions: [Question] = [
        Question(id: 1, text: "Закрепы против отсутствуют?", isVpnQuestion: false),
        Question(id: 2, text: "Импульсного пролива нет?", isVpnQuestion: false),
        Question(id: 3, text: "СМТ все чисто?", isVpnQuestion: false),
        Question(id: 4, text: "До 2х стопов за сегодня?", isVpnQuestion: false),
        Question(id: 5, text: "Готов получить стопа за эту идею?", isVpnQuestion: false),
        Question(id: 6, text: "5м модель есть, не спешим, лучше лимиткой на тесте?", isVpnQuestion: false),
        Question(id: 7, text: "ВПН ВЫКЛЮЧИЛ?", isVpnQuestion: true)
    ]
}
