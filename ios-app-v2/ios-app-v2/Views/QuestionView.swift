import SwiftUI

struct QuestionView: View {
    let question: Question
    let onAnswer: (AnswerType) -> Void

    var backgroundColor: Color {
        question.isVpnQuestion ? .white : Color(.systemGray6)
    }

    var textColor: Color {
        question.isVpnQuestion ? .black : .primary
    }

    var body: some View {
        VStack(spacing: 20) {
            Text(question.text)
                .font(.title2)
                .fontWeight(.semibold)
                .foregroundColor(textColor)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .padding(.vertical, 20)

            HStack(spacing: 12) {
                // Green button
                Button(action: { onAnswer(.green) }) {
                    Text("✓")
                        .font(.system(size: 18, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.green)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }

                // Yellow button (only for non-VPN questions)
                if !question.isVpnQuestion {
                    Button(action: { onAnswer(.yellow) }) {
                        Text("⚠")
                            .font(.system(size: 18, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.yellow)
                            .foregroundColor(.black)
                            .cornerRadius(10)
                    }
                }

                // Red button
                Button(action: { onAnswer(.red) }) {
                    Text("✕")
                        .font(.system(size: 18, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.red)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 20)
        }
        .background(backgroundColor)
        .cornerRadius(12)
        .shadow(radius: 2)
        .padding(16)
    }
}

#Preview {
    VStack(spacing: 20) {
        QuestionView(question: Question(id: 1, text: "Уровень доступа верный?", isVpnQuestion: false)) { _ in }
        QuestionView(question: Question(id: 7, text: "ВПН ВЫКЛЮЧИЛ?", isVpnQuestion: true)) { _ in }
    }
}
