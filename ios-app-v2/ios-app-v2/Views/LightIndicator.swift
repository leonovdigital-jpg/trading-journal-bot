import SwiftUI

struct LightIndicator: View {
    let status: AnswerType

    var statusColor: Color {
        switch status {
        case .green:
            return .green
        case .yellow:
            return .yellow
        case .red:
            return .red
        case .none:
            return .yellow
        }
    }

    var statusText: String {
        switch status {
        case .green:
            return "✓"
        case .yellow:
            return "⚠"
        case .red:
            return "✕"
        case .none:
            return "◆"
        }
    }

    var body: some View {
        VStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 60, height: 60)
                .overlay(
                    Text(statusText)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundColor(.white)
                )
                .shadow(radius: 4)

            Text(statusDescription)
                .font(.caption)
                .foregroundColor(.gray)
        }
    }

    var statusDescription: String {
        switch status {
        case .green:
            return "Готово к торговле"
        case .yellow:
            return "Предупреждение"
        case .red:
            return "Торговля заблокирована"
        case .none:
            return "Ожидание"
        }
    }
}

#Preview {
    VStack(spacing: 20) {
        LightIndicator(status: .none)
        LightIndicator(status: .yellow)
        LightIndicator(status: .green)
        LightIndicator(status: .red)
    }
    .padding()
}
