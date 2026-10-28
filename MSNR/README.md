# MSNR — план обучения

План, глоссарий, этапы и шаблон разбора сделок живут в документе Claude:
https://claude.ai/artifact/WCvMwxKriTHKqrqbPKx9dr

Актив для обучения — XAUUSD (третий актив; основные — UK100 и USDCHF по SMC).

## Видео от ребят

Видео перетащить в VS Code в папку `MSNR/materials/` (или прислать ссылку). Дальше:

    python3 ~/tools/video-notes/video_notes.py transcript MSNR/materials/<видео>.mp4
    python3 ~/tools/video-notes/video_notes.py summary <ссылка|файл> MSNR/materials

`transcript` — дословная расшифровка с таймкодами и кадрами экрана (`<видео>/transcript.md`, `frames/`);
`summary` — конспект. Инструмент общий (им же пользуется чат «🎬 Конспект видео» в Telegram),
ключ — `GEMINI_API_KEY` в `~/tools/video-notes/.env`, бесплатный тариф.
В git попадают только расшифровки: видео, звук и кадры исключены в `.gitignore`.
