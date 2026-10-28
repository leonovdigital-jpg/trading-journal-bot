# MSNR — план обучения

План, глоссарий, этапы и шаблон разбора сделок живут в документе Claude:
https://claude.ai/artifact/WCvMwxKriTHKqrqbPKx9dr

Актив для обучения — XAUUSD (третий актив; основные — UK100 и USDCHF по SMC).

## Видео от ребят

Видео перетащить в VS Code в папку `MSNR/materials/` (или прислать ссылку). Дальше:

    python3 MSNR/tools/video_notes.py MSNR/materials/<видео>.mp4

Результат — `MSNR/materials/<видео>/transcript.md`: дословная расшифровка Gemini с таймкодами
и ссылками на кадры экрана (`frames/`). Ключ — `GEMINI_API_KEY` в `Trading/.env`, бесплатный тариф
(Pro-модели на нём закрыты, работают Flash; скрипт перебирает несколько и повторяет при перегрузке).
В git попадают только расшифровки: видео, звук и кадры исключены в `.gitignore`.
