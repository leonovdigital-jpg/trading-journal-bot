#!/bin/bash
# Читает экономический календарь FundingPips из Safari пользователя и отправляет
# его в журнальную таблицу, откуда бот вставляет события в утреннюю сводку.
#
# Почему на Маке, а не на сервере: кабинет FundingPips закрыт защитой Vercel от
# ботов, а календарь у фирмы свой, нигде больше его нет. В Safari пользователь
# уже вошёл, и для FundingPips это обычный визит с его браузера и его адреса.
#
# Главное правило: при включённом VPN страницу FundingPips НЕ открывать вообще.
# Проп следит за адресами входа, вход с VPN-адреса может стоить счёта. Поэтому
# проверяется и само приложение AmneziaVPN, и то, куда реально уходит трафик.
#
# Запускается планировщиком каждые 10 минут; работает по будням с 07:00 до открытия
# Лондона, один раз в день после удачного чтения.
#   fp-calendar.sh          — обычный запуск по расписанию
#   fp-calendar.sh --now    — прочитать прямо сейчас, без проверки часов и «уже сделано»
#                             (VPN проверяется всегда)

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HOME/Library/Application Support/fp-calendar"
LOG="$HOME/Library/Logs/fp-calendar.log"
URL_EXEC="https://script.google.com/macros/s/AKfycbyrKuqc4_RwXsu2y_kCZVLbD6BUFMnqyzuokQun-4J13aWQlc96pgME2Ai3vef_oYVhQw/exec"
mkdir -p "$STATE"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

KEY="$(cat "$STATE/key" 2>/dev/null)"
if [ -z "$KEY" ]; then log "нет ключа таблицы в $STATE/key"; exit 1; fi

TODAY="$(date +%F)"
NOW_MODE=0; [ "${1:-}" = "--now" ] && NOW_MODE=1
# Разовый принудительный запуск через планировщик (так делает установка).
if [ -f "$STATE/force" ]; then rm -f "$STATE/force"; NOW_MODE=1; fi

if [ $NOW_MODE -eq 0 ]; then
  [ "$(date +%u)" -ge 6 ] && exit 0                         # суббота, воскресенье
  # С 07:00 по местному времени и до открытия Лондона — 08:00 по лондонским часам.
  # Лондон считаем по его собственному поясу: при переходе на летнее время граница
  # сама сдвигается с 11:00 на 10:00 по Минску.
  HM=$((10#$(date +%H%M)))
  LON=$((10#$(TZ=Europe/London date +%H%M)))
  { [ $HM -lt 700 ] || [ $LON -ge 800 ]; } && exit 0
  [ -f "$STATE/done-$TODAY" ] && exit 0
fi

# Один запуск за раз: планировщик может дёрнуть, пока предыдущий ещё читает.
LOCK="$STATE/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Замок старше 10 минут — остаток упавшего запуска.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK"; mkdir "$LOCK" || exit 0; else exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

send() {   # send <status> <reason> <json-or-null>
  local body
  body=$(printf '{"action":"setFpCalendar","key":"%s","date":"%s","status":"%s","reason":"%s","data":%s}' \
    "$KEY" "$TODAY" "$1" "$(printf '%s' "$2" | tr -d '"\\\n')" "${3:-null}")
  for i in 1 2 3; do
    # Apps Script отвечает редиректом; -L сам переходит на страницу с ответом.
    if curl -sL -m 60 -H 'Content-Type: application/json' -d "$body" "$URL_EXEC" | grep -q '"success":true'; then
      log "отправлено: $1 $2"; return 0
    fi
    sleep $((i * 5))
  done
  log "не смог отправить в таблицу: $1 $2"; return 1
}

vpn_reason() {
  # Само приложение. Служба AmneziaVPN-service может работать в фоне всегда — её не считаем,
  # смотрим именно окно приложения.
  if pgrep -xq AmneziaVPN || pgrep -fq 'AmneziaVPN\.app/Contents/MacOS/AmneziaVPN( |$)'; then
    echo "открыто приложение AmneziaVPN"; return
  fi
  # Куда реально уходит трафик. Маршрут по умолчанию у VPN бывает прежним, а трафик
  # при этом идёт в туннель — поэтому смотрим маршрут до конкретных адресов.
  local host ifc
  for host in app.fundingpips.com 1.1.1.1 8.8.8.8; do
    ifc=$(route -n get "$host" 2>/dev/null | awk '/interface:/{print $2}')
    case "$ifc" in utun*|tun*|ppp*|ipsec*|wg*) echo "трафик к $host идёт через туннель $ifc"; return;; esac
  done
}

REASON="$(vpn_reason)"
if [ -n "$REASON" ]; then
  log "VPN: $REASON — FundingPips не открываю"
  send vpn "$REASON" null
  exit 0
fi

RAW="$(osascript "$HERE/read-calendar.applescript" "$HERE/extract.js" 2>"$STATE/osa-error.txt")"
OSA_ERR="$(tr '\n' ' ' < "$STATE/osa-error.txt" | cut -c1-250)"

if [ -z "$RAW" ]; then
  if echo "$OSA_ERR" | grep -qi 'JavaScript'; then
    send error "Safari не даёт скрипту читать страницу: включи Разработка → Разрешить JavaScript из Apple Events" null
  elif echo "$OSA_ERR" | grep -qiE 'not allowed|-1743|authoriz'; then
    send error "macOS не разрешила управлять Safari: Настройки → Конфиденциальность → Автоматизация" null
  else
    send error "Safari ничего не вернул: $OSA_ERR" null
  fi
  exit 1
fi

STATE_ON_PAGE="$(printf '%s' "$RAW" | grep -o '"state":"[a-z_]*"' | head -1 | cut -d'"' -f4)"
case "$STATE_ON_PAGE" in
  ok)         send ok "" "$RAW" && touch "$STATE/done-$TODAY" ;;
  empty)      send empty "календарь открылся, строк не нашлось" "$RAW" && touch "$STATE/done-$TODAY" ;;
  logged_out) send logged_out "тебя выкинуло из кабинета FundingPips" null ;;
  blocked)    send blocked "защита сайта FundingPips не пустила Safari" null ;;
  *)          send error "непонятный ответ страницы" null ;;
esac

# Старые отметки «сделано» не копим.
find "$STATE" -name 'done-*' -mtime +7 -delete 2>/dev/null
exit 0
