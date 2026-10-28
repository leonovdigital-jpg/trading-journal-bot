"""Видео вебинара → дословная расшифровка с таймкодами + ключевые кадры.

Звук режется на куски по 20 минут и расшифровывается Gemini (ключ GEMINI_API_KEY в Trading/.env).
Кадры: экран снимается раз в FRAME_STEP секунд, кадр сохраняется, когда он заметно отличается
от последнего сохранённого (дорисованная линия на графике тоже считается), но не чаще раза
в FRAME_MIN_GAP секунд. Ссылки на кадры вставляются в расшифровку по времени.

    python3 MSNR/tools/video_notes.py путь/к/видео.mp4 [папка-результата]

По умолчанию результат — MSNR/materials/<имя видео>/: transcript.md, frames/, chunks/.
Повторный запуск не расшифровывает заново уже готовые куски (они лежат в chunks/).
"""
import base64
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CHUNK_SEC = 20 * 60
FRAME_STEP = 5          # как часто смотреть на экран, секунд
FRAME_MIN_GAP = 10      # не чаще одного кадра за столько секунд
THUMB_W, THUMB_H = 320, 180
PIXEL_DIFF = 20         # пиксель изменился, если яркость сдвинулась больше чем на столько (из 255)
CHANGED_SHARE = 0.001   # кадр новый, если изменилась такая доля пикселей (0,1% ≈ короткая линия)
MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.1-flash-lite"]
RETRY_WAITS = [15, 45, 90]

PROMPT = """Это аудио из вебинара по трейдингу (Smart Money, MSNR, уровни поддержки и сопротивления, золото XAUUSD, индексы, форекс).
Сделай ДОСЛОВНУЮ расшифровку речи на языке оригинала. Не пересказывай, не сокращай, не исправляй смысл, не добавляй ничего от себя.
Термины пиши так, как их произносят: A-уровень, V-уровень, свежий, несвежий, гэп, QML, POI, FVG, OB, BOS, CHoCH и т.п.; английские термины — латиницей.
Разбивай на абзацы по 15–40 секунд. Каждый абзац начинай с таймкода от начала ЭТОГО аудиофрагмента в формате [MM:SS].
Если говорящих несколько и их можно различить, ставь «Спикер 1:», «Спикер 2:» (если по речи понятно имя — имя).
Неразборчивое помечай [неразборчиво]. Выведи только расшифровку, без вступлений и выводов."""


def api_key() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("Нет GEMINI_API_KEY в Trading/.env")


def ffmpeg(*args: str) -> str:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-y", *args], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"ffmpeg упал:\n{r.stderr[-2000:]}")
    return r.stderr


def duration(video: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def hms(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def cut_audio(video: Path, chunks: Path) -> list[Path]:
    """Моно mp3 32 кбит/с: 20 минут ≈ 5 МБ — влезает в запрос без отдельной загрузки файла."""
    if not sorted(chunks.glob("audio_*.mp3")):
        ffmpeg("-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
               "-f", "segment", "-segment_time", str(CHUNK_SEC), str(chunks / "audio_%02d.mp3"))
    return sorted(chunks.glob("audio_*.mp3"))


def gemini(key: str, audio: Path) -> str:
    body = json.dumps({
        "contents": [{"parts": [
            {"inlineData": {"mimeType": "audio/mp3", "data": base64.b64encode(audio.read_bytes()).decode()}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 65536},
    }).encode()
    errors = []
    for wait in [0, *RETRY_WAITS]:
        time.sleep(wait)
        for model in MODELS:
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=body, headers={"x-goog-api-key": key, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    d = json.load(r)
            except urllib.error.HTTPError as e:
                errors.append(f"{model}: {e.code} {e.read()[:200]!r}")
                if e.code in (429, 500, 503, 404):
                    continue  # перегружена / лимит / недоступна — следующая модель
                raise
            cand = d["candidates"][0]
            text = "".join(p.get("text", "") for p in cand["content"]["parts"] if not p.get("thought"))
            if cand.get("finishReason") == "MAX_TOKENS":
                print(f"  ! {audio.name}: ответ обрезан по длине — уменьшить CHUNK_SEC", file=sys.stderr)
            print(f"  {audio.name}: {model} ({d.get('modelVersion')}), {len(text)} символов")
            return text
    sys.exit(f"Gemini не ответил по {audio.name}:\n" + "\n".join(errors[-len(MODELS):]))


TS = re.compile(r"^\s*\**\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\**\s*")


def paragraphs(text: str, offset: float) -> list[tuple[float, str]]:
    """Абзацы с абсолютным временем; строки без таймкода приклеиваются к предыдущему абзацу."""
    out: list[tuple[float, str]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = TS.match(line)
        if m:
            h, mm, ss = (int(g or 0) for g in m.groups())
            out.append((offset + h * 3600 + mm * 60 + ss, line[m.end():].strip()))
        elif out:
            out[-1] = (out[-1][0], out[-1][1] + " " + line.strip())
        else:
            out.append((offset, line.strip()))
    return out


def pick_times(video: Path) -> list[int]:
    """Секунды, в которые картинка заметно изменилась относительно последнего сохранённого кадра."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-an",
         "-vf", f"fps=1/{FRAME_STEP},scale={THUMB_W}:{THUMB_H},format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True).stdout
    thumbs = np.frombuffer(raw, np.uint8).reshape(-1, THUMB_H * THUMB_W).astype(np.int16)
    times, last = [0], thumbs[0]
    for i in range(1, len(thumbs)):
        t = i * FRAME_STEP
        changed = np.mean(np.abs(thumbs[i] - last) > PIXEL_DIFF) > CHANGED_SHARE
        if changed and t - times[-1] >= FRAME_MIN_GAP:
            times.append(t)
            last = thumbs[i]
    return times


def cut_frames(video: Path, frames: Path) -> list[tuple[float, str]]:
    """Имя файла — время кадра: f_0012530.jpg = 1:25:30."""
    if not sorted(frames.glob("f_*.jpg")):
        for t in pick_times(video):
            ffmpeg("-ss", str(t), "-i", str(video), "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2",
                   "-q:v", "4", str(frames / f"f_{hms(t).replace(':', '')}.jpg"))
    out = []
    for f in sorted(frames.glob("f_*.jpg")):
        h = f.stem[2:]
        out.append((int(h[:-4]) * 3600 + int(h[-4:-2]) * 60 + int(h[-2:]), f.name))
    return out


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    video = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ROOT / "MSNR" / "materials" / video.stem
    chunks, frames = out / "chunks", out / "frames"
    chunks.mkdir(parents=True, exist_ok=True)
    frames.mkdir(exist_ok=True)
    key = api_key()
    total = duration(video)
    print(f"{video.name}: {hms(total)}")

    print("Кадры…")
    shots = cut_frames(video, frames)
    print(f"  {len(shots)} кадров")

    print("Расшифровка…")
    paras: list[tuple[float, str]] = []
    for i, audio in enumerate(cut_audio(video, chunks)):
        cache = audio.with_suffix(".txt")
        if not cache.exists():
            cache.write_text(gemini(key, audio))
        paras += paragraphs(cache.read_text(), i * CHUNK_SEC)

    # кадры встают перед первым абзацем, который начинается не раньше кадра
    events = [(t, 0, f"![кадр {hms(t)}](frames/{name})") for t, name in shots]
    events += [(t, 1, f"**[{hms(t)}]** {text}") for t, text in paras]
    lines = [f"# {video.stem}", "", f"Длительность {hms(total)} · абзацев {len(paras)} · кадров {len(shots)}.",
             "Расшифровка Gemini, дословная; таймкоды — от начала видео, точность ± несколько секунд.", ""]
    lines += [e[2] + "\n" for e in sorted(events)]
    (out / "transcript.md").write_text("\n".join(lines))
    print(f"Готово: {out / 'transcript.md'}")


if __name__ == "__main__":
    main()
