#!/bin/bash
# Недельный разбор торгового журнала. Запускается таймером по субботам.
#
# Почему здесь, а не в облаке Claude: у облачной песочницы сеть закрыта белым
# списком, который может открыть только пользователь руками. Два запуска подряд
# умерли на этом. На сервере сеть открыта, и разбор ни от чего не зависит.
#
# Пользователь analyst намеренно отдельный и без sudo: ему не видны ни бот,
# ни токен телеграма, ни профиль TradingView. Разбору хватает журнала через
# Apps Script, котировок и картинок.
set -u

cd /home/analyst/review || exit 1

export PATH="/home/analyst/.npm-global/bin:$PATH"
set -a
. /home/analyst/review/.env
set +a

LOG=/home/analyst/review/last-run.log
: > "$LOG"

echo "=== запуск $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

timeout 2700 claude -p "$(cat /home/analyst/review/PROMPT.md)" \
  --model opus \
  --allowedTools Bash Read Write Edit Glob Grep \
  --dangerously-skip-permissions \
  >> "$LOG" 2>&1

code=$?
echo "=== код выхода $code, $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

# Если разбор упал молча, пользователь об этом не узнает: отчёт просто не придёт.
# Поэтому кладём в тот же почтовый ящик короткое сообщение о поломке.
if [ $code -ne 0 ] && ! grep -q '"success":true' "$LOG"; then
  node -e '
    const { post } = require("/home/analyst/review/sheets.js");
    post({ action: "saveReport", from: "", to: "",
      text: "Недельный разбор не получился: задача завершилась с ошибкой. Логи на сервере: /home/analyst/review/last-run.log" })
      .then(r => console.log(JSON.stringify(r)))
      .catch(e => console.error(e.message));
  ' >> "$LOG" 2>&1
fi

exit $code
