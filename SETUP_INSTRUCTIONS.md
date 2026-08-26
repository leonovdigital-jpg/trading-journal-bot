# 🚀 Инструкции по запуску Trade Journal Bot

## ✅ Что уже сделано

- ✓ Установлены все зависимости (Telegram API, Playwright, Google Sheets API)
- ✓ Написан основной код бота
- ✓ Подготовлены модули для Google Sheets и Drive
- ✓ TradingView credentials уже добавлены в .env

## 📋 Что нужно сделать

### Шаг 1: Создать Google Cloud Проект (5 минут)

1. Иди на https://console.cloud.google.com/
2. Нажми "Select a Project" → "New Project"
3. Назови проект "Trade Journal Bot" → "Create"
4. Подожди загрузку проекта

### Шаг 2: Включить Google APIs (3 минуты)

1. Вверху поиск → напиши "Google Sheets API"
2. Нажми первый результат → "Enable"
3. Поиск → "Google Drive API" → "Enable"

### Шаг 3: Создать OAuth Credentials (5 минут)

1. В левом меню: "Credentials"
2. "Create Credentials" → "OAuth client ID"
3. Если спросит "Configure consent screen" → нажми "Configure"
4. Выбери "External" → "Create"
5. Заполни:
   - App name: "Trade Journal Bot"
   - User support email: твой email
   - Нажми "Save and Continue" дважды
6. Вернись на Credentials
7. "Create Credentials" → "OAuth client ID"
8. Application type: "Desktop application"
9. Name: "Trade Journal Bot Desktop"
10. "Create"
11. Нажми "Download JSON" (иконка скачивания)

### Шаг 4: Добавить Credentials (1 минута)

1. Скачанный JSON файл переименуй в `credentials.json`
2. Положи его в папку проекта: `/Users/kirylleonau/Documents/0 AI/Trading/`

### Шаг 5: Авторизовать Бота (2 минуты)

В терминале выполни:
```bash
cd "/Users/kirylleonau/Documents/0 AI/Trading"
node setup-oauth.js
```

Программа выведет ссылку для авторизации. Открой её в браузере, нажми "Allow", скопируй полученный код и вставь в консоль.

### Шаг 6: Дать доступ к Google Sheets

1. Открой свою таблицу Trade Journal Bot в Google Sheets
2. Нажми Share (Поделиться)
3. В файле `token.json` (создастся после step 5) найди `"client_email"`
4. Скопируй этот email
5. В Google Sheets вставь этот email как редактор

Или, если используешь OAuth (проще):
- Просто давай боту доступ через браузер при авторизации

### Шаг 7: Запустить Бот

```bash
node bot.js
```

Бот будет писать в консоль и слушать Telegram.

## 🧪 Тестирование

1. Напиши боту в Telegram: `/start`
2. Бот ответит с инструкциями
3. Отправь любой скриншот (или картинку в качестве теста)
4. Следуй диалогу

## 🐛 Если что-то не работает

**"No credentials found"**
- Убедись, что `credentials.json` в правильной папке

**"Token not found"**  
- Запусти `node setup-oauth.js` ещё раз

**Бот не отвечает в Telegram**
- Проверь TELEGRAM_TOKEN в `.env`
- Убедись, что бот включен и админ чата его добавил

**Не могу залогиниться в TradingView**
- Проверь email и пароль в `.env`
- Может быть 2FA? Отключи его временно или используй app password

## 📊 Когда всё работает

1. Отправишь скриншот в Telegram
2. Выберешь актив, сессию и напишешь мысли
3. Бот автоматически захватит скриншоты с других таймфреймов
4. Всё загрузится в Google Sheets с ссылками на скриншоты

Ready? 🚀
