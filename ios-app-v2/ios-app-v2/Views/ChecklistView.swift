import SwiftUI

struct ChecklistView: View {
    @StateObject private var appState = AppState()

    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // Header with light indicator
                VStack(spacing: 16) {
                    LightIndicator(status: appState.lightStatus)

                    HStack {
                        Text("Отказы за день:")
                            .font(.subheadline)
                        Spacer()
                        Text("\(appState.denialCount)")
                            .font(.subheadline)
                            .fontWeight(.bold)
                            .foregroundColor(.red)
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.vertical, 20)
                .background(Color(.systemGray6))

                // Checklist progress
                if !appState.isCompleted {
                    VStack(spacing: 8) {
                        HStack {
                            Text("Вопрос \(appState.currentQuestionIndex + 1) из \(appState.questions.count)")
                                .font(.caption)
                                .foregroundColor(.gray)
                            Spacer()
                        }
                        .padding(.horizontal, 16)

                        ProgressView(value: Double(appState.currentQuestionIndex), total: Double(appState.questions.count))
                            .padding(.horizontal, 16)
                    }
                    .padding(.vertical, 12)
                }

                // Question or completion
                ScrollView {
                    if appState.isCompleted {
                        CompletionView(appState: appState)
                    } else {
                        QuestionView(
                            question: appState.questions[appState.currentQuestionIndex],
                            onAnswer: { answer in
                                appState.answerQuestion(with: answer)
                            }
                        )
                    }
                }

                Spacer()
            }

            // Denial alert
            if appState.showDenialAlert {
                VStack {
                    Text("Торговля заблокирована")
                        .font(.headline)
                        .foregroundColor(.red)

                    Text("Проверьте ответы и попробуйте снова")
                        .font(.body)
                        .foregroundColor(.gray)
                        .padding(.top, 8)

                    Button(action: {
                        appState.showDenialAlert = false
                        appState.currentQuestionIndex = 0
                        appState.questions = Question.allQuestions
                        appState.lightStatus = .none
                    }) {
                        Text("Начать заново")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.orange)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                    }
                    .padding(.top, 16)
                }
                .padding(20)
                .background(Color(.systemBackground))
                .cornerRadius(12)
                .shadow(radius: 4)
                .padding(16)
            }
        }
        .onAppear {
            appState.resetForNewDay()
        }
    }
}

struct CompletionView: View {
    let appState: AppState

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 60))
                .foregroundColor(.green)

            Text("Все проверки пройдены!")
                .font(.title2)
                .fontWeight(.semibold)

            Text("Доступ разрешён")
                .font(.body)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)

            Spacer()

            Button(action: {
                appState.resetChecklist()
            }) {
                Text("Завершить")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(8)
            }
        }
        .padding(16)
    }

    @ViewBuilder
    func statusBadge(for status: AnswerType) -> some View {
        switch status {
        case .green:
            Text("✓")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.green)
        case .yellow:
            Text("⚠")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.yellow)
        case .red:
            Text("✕")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.red)
        case .none:
            Text("—")
                .foregroundColor(.gray)
        }
    }
}

#Preview {
    ChecklistView()
}
