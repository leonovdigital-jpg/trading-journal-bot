#!/bin/bash
# Установка чтения календаря FundingPips на Мак. Запускается одной командой:
#   curl -fsSL https://raw.githubusercontent.com/leonovdigital-jpg/trading-journal-bot/main/mac/fp-calendar/install.sh | bash
# Спросит ключ таблицы (вводится скрыто), поставит скрипты и расписание и сразу
# сделает первое чтение, чтобы macOS спросила разрешение, пока ты у экрана.
set -eu

# 13.11.2026 установку случайно запустили в терминале VS Code — а он подключён
# к Linux-серверу, не к Маку. Дошло до последнего шага и упало на launchctl,
# оставив на сервере файлы и ключ. Теперь проверяем сразу.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Это не Мак (система: $(uname -s), компьютер: $(hostname))."
  echo "Запусти команду в приложении «Терминал» на самом Маке: Cmd + Пробел → Терминал."
  exit 1
fi

RAW="https://raw.githubusercontent.com/leonovdigital-jpg/trading-journal-bot/main/mac/fp-calendar"
DIR="$HOME/.local/share/fp-calendar"
STATE="$HOME/Library/Application Support/fp-calendar"
PLIST="$HOME/Library/LaunchAgents/com.leonov.fpcalendar.plist"
LABEL="com.leonov.fpcalendar"

mkdir -p "$DIR" "$STATE" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

echo "1/4 Скачиваю скрипты…"
for f in fp-calendar.sh read-calendar.applescript extract.js; do
  curl -fsSL "$RAW/$f" -o "$DIR/$f"
done
chmod +x "$DIR/fp-calendar.sh"

echo "2/4 Ключ таблицы."
if [ -s "$STATE/key" ]; then
  echo "   Уже есть, оставляю прежний."
else
  printf "   Вставь ключ, который я прислал, и нажми Enter (символы не будут видны): "
  read -rs KEY < /dev/tty; echo
  [ -n "$KEY" ] || { echo "Пустой ключ — остановился."; exit 1; }
  printf '%s' "$KEY" > "$STATE/key"
  chmod 600 "$STATE/key"
fi

echo "3/4 Ставлю расписание: каждые 10 минут, скрипт сам решает, пора ли."
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/fp-calendar.sh</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/fp-calendar.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/fp-calendar.log</string>
</dict>
</plist>
EOF
echo "4/4 Включаю расписание и сразу делаю первое чтение."
echo "   Если macOS спросит, можно ли управлять Safari, — нажми «Разрешить» (OK)."
# Первое чтение делает сам планировщик (RunAtLoad), а не Терминал: разрешение macOS
# выдаётся тому, кто запускает, и иначе вопрос всплыл бы потом в 08:40, когда тебя
# нет у экрана. Отметка force заставляет этот запуск не смотреть на часы.
touch "$STATE/force"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 90); do [ -f "$STATE/force" ] || break; sleep 1; done
sleep 50
echo
echo "Готово. Последние строки журнала:"
tail -n 3 "$HOME/Library/Logs/fp-calendar.log" 2>/dev/null || true
