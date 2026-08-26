import SwiftUI

struct ContentView: View {
  @StateObject var viewModel = ChecklistViewModel()

  var body: some View {
    ZStack {
      Color(red: 0.1, green: 0.1, blue: 0.1).ignoresSafeArea()

      VStack(spacing: 40) {
        IndicatorLight(status: $viewModel.lampStatus)
          .frame(height: 80)

        if viewModel.currentQuestionIndex < viewModel.questions.count {
          QuestionView(
            question: viewModel.questions[viewModel.currentQuestionIndex],
            onAnswer: viewModel.answer
          )
        } else {
          ResultView(
            isSuccess: viewModel.isSuccess,
            rejectCount: viewModel.rejectCount
          )
        }

        Spacer()
      }
      .padding(30)
    }
    .preferredColorScheme(.dark)
  }
}

struct IndicatorLight: View {
  @Binding var status: LampStatus

  var body: some View {
    VStack {
      Circle()
        .fill(status.color)
        .frame(width: 60, height: 60)
        .shadow(color: status.shadowColor, radius: 15)
      Spacer()
    }
  }
}

struct QuestionView: View {
  let question: Question
  let onAnswer: (String, Bool) -> Void

  var body: some View {
    VStack(spacing: 40) {
      Text(question.text)
        .font(.system(size: 24, weight: .bold))
        .foregroundColor(question.isVpnQuestion ? .black : .white)
        .multilineTextAlignment(.center)

      VStack(spacing: 15) {
        ForEach(question.buttons, id: \.value) { button in
          Button(action: { onAnswer(button.value, button.blocking) }) {
            Text(button.label)
              .font(.system(size: 18, weight: .bold))
              .frame(maxWidth: .infinity)
              .padding(18)
              .foregroundColor(button.color == "yellow" ? .black : .white)
              .background(button.color == "green" ? Color.green : button.color == "red" ? Color.red : Color(red: 1, green: 0.72, blue: 0.3))
              .cornerRadius(6)
          }
        }
      }
    }
    .padding(30)
    .background(question.isVpnQuestion ? Color.white : Color.clear)
    .cornerRadius(6)
  }
}

struct ResultView: View {
  let isSuccess: Bool
  let rejectCount: Int

  var body: some View {
    VStack(spacing: 40) {
      Text(isSuccess ? "ДОПУСК РАЗРЕШЁН" : "ДОСТУП ЗАПРЕЩЁН")
        .font(.system(size: 20, weight: .bold))
        .foregroundColor(isSuccess ? .green : .red)

      VStack(spacing: 15) {
        HStack {
          Text("Отказов сегодня:")
            .font(.system(size: 16))
            .foregroundColor(Color(red: 0.7, green: 0.7, blue: 0.7))

          Text("\(rejectCount)")
            .font(.system(size: 16, weight: .bold))
            .foregroundColor(.white)
        }
      }
      .padding(20)
      .background(Color(red: 0.15, green: 0.15, blue: 0.15))
      .cornerRadius(6)
    }
  }
}

#Preview {
  ContentView()
}
