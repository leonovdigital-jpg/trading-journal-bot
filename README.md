# Trade Journal Bot 📊

Телеграм-бот для автоматизации записи сделок в Google Sheets прямо из TradingView.

## Возможности

- 📸 Захват скриншотов из TradingView (5m, 1h, 4h, 1d)
- 💬 Диалоговый интерфейс в Telegram
- 📊 Автоматическая загрузка данных в Google Sheets
- 💱 Поддержка DXY для USDCHF сделок

## Установка

### 1. Зависимости
```bash
npm install
```

### 2. TradingView credentials
Отредактируй `.env` файл:
```
TRADINGVIEW_EMAIL=твой_email@gmail.com
TRADINGVIEW_PASSWORD=твой_пароль
TELEGRAM_TOKEN=твой_токен_бота
GOOGLE_SHEETS_ID=id_твоей_таблицы
```

### 3. Google OAuth Setup

1. Иди на https://console.cloud.google.com/
2. Создай новый проект
3. Enable APIs:
   - Google Sheets API
   - Google Drive API
4. Создай OAuth 2.0 Desktop Application credentials
5. Скачай JSON файл и сохрани как `credentials.json` в корне проекта
6. Запусти:
   ```bash
   node setup-oauth.js
   ```
7. Следуй инструкциям в консоли

## Запуск

```bash
node bot.js
```

Бот будет ждать сообщения в Telegram.

## Использование

1. Отправь скриншот из TradingView (5m или 1m)
2. Выбери актив (USDCHF, UK100, US30)
3. Выбери сессию (LO, NY, NYSE)
4. Напиши свои мысли перед входом
5. Бот автоматически захватит другие таймфреймы и загрузит в Google Sheets

## Структура таблицы

| Колонка | Назначение |
|---------|-----------|
| Date & Time | Дата и время сделки |
| Day | День недели |
| Session | Торговая сессия |
| Pair | Торговая пара |
| Мысли до | Твои заметки перед входом |
| Position | Long/Short |
| Ошибки | Допущенные ошибки |
| 1-5 | Оценка сделки |
| 1h | Скриншот 1h |
| 4h | Скриншот 4h |
| 1d | Скриншот 1d |
| SMT1 | DXY 1h (для USDCHF) |
| smt4 | DXY 4h (для USDCHF) |
| smt 1d | DXY 1d (для USDCHF) |

## Troubleshooting

**Проблема:** "No credentials found"
- Решение: Убедись, что `credentials.json` есть в корне проекта

**Проблема:** "Token not found"
- Решение: Запусти `node setup-oauth.js` и следуй инструкциям

**Проблема:** Не может залогиниться в TradingView
- Решение: Проверь email и пароль в `.env`

## Безопасность

- ❌ Никогда не коммитьте `.env`, `credentials.json`, `token.json`
- ✅ Используй сильный пароль для Google аккаунта
- ✅ Регулярно проверяй доступ в Google Drive
