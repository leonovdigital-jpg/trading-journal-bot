"""Отчёт по логам Pine-индикатора pine/zakrep-fractal.pine.

Вход — JSON, собранный из панели Pine Logs ({"lines": ["[...]: CASE;...", "[...]: RACE;..."]}).
Выход — README.md в папке отчёта (картинки дней лежат рядом в days/).

    python3 tools/report.py reports/2025-01_zakrep-fractal
"""
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CASE_FIELDS = ["t", "sess", "dir", "close", "lvl", "lvlT", "origin", "conflict", "body", "first",
               "tA", "tfA", "kA", "tB", "tfB", "kB", "res", "resT", "mfe", "mae", "lonMove", "dayMove", "revT"]
SESS = {"F": "Франкфурт", "L": "Лондон", "U": "США"}
KIND = {"1": "фрактал", "2": "имбаланс"}
RES_ICON = {"WIN": "✅", "LOSS": "❌", "BOTH": "❓", "NONE": "⏳"}


MINSK = timezone(timedelta(hours=3))
NY = ZoneInfo("America/New_York")


def trading_day(t: str) -> str:
    """Торговый день Pepperstone в TradingView начинается в 18:00 по Нью-Йорку (с началом Азии)."""
    dt = datetime.strptime(t, "%Y-%m-%d %H:%M").replace(tzinfo=MINSK).astimezone(NY)
    return (dt + timedelta(hours=6)).strftime("%Y-%m-%d")


def num(x):
    return float(x) if x not in ("", None) else None


def load(folder: Path):
    raw = json.loads((folder / "pine-logs.json").read_text(encoding="utf-8"))["lines"]
    msgs = [l.split("]: ", 1)[1] for l in raw]
    cases, races = [], []
    for m in msgs:
        p = m.split(";")
        if p[0] == "CASE":
            c = dict(zip(CASE_FIELDS, p[1:]))
            for k in ("close", "lvl", "tA", "tB", "mfe", "mae", "lonMove", "dayMove"):
                c[k] = num(c[k])
            c["first"] = c["first"] == "1"
            c["body"] = c["body"] == "1"
            c["conflict"] = c["conflict"] == "1"
            c["day"] = trading_day(c["t"])
            cases.append(c)
        elif p[0] == "RACE":
            races.append({"t": p[1], "day": trading_day(p[1]), "sess": p[2], "up": num(p[3]), "dn": num(p[4]), "res": p[5]})
    cases.sort(key=lambda c: c["t"])
    races.sort(key=lambda r: r["t"])
    return cases, races


def base_probs(races):
    """Доля «вверх первым» и «вниз первым» среди решённых гонок по каждой сессии и в целом."""
    out = {}
    for key in ("F", "L", "U", "all"):
        rs = [r for r in races if key == "all" or r["sess"] == key]
        up = sum(r["res"] == "UP" for r in rs)
        dn = sum(r["res"] == "DN" for r in rs)
        out[key] = {"n": len(rs), "up": up, "dn": dn, "none": sum(r["res"] == "NONE" for r in rs),
                    "both": sum(r["res"] == "BOTH" for r in rs),
                    "pUp": up / (up + dn) if up + dn else None, "pDn": dn / (up + dn) if up + dn else None}
    return out


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "—"


def row(name, cs, base):
    n = len(cs)
    cnt = Counter(c["res"] for c in cs)
    w, l = cnt["WIN"], cnt["LOSS"]
    decided = [c for c in cs if c["res"] in ("WIN", "LOSS")]
    exp = None
    if decided:
        vals = []
        for c in decided:
            b = base[c["sess"]]
            p = b["pUp"] if c["dir"] == "L" else b["pDn"]
            if p is not None:
                vals.append(p)
        exp = sum(vals) / len(vals) if vals else None
    # случайное блуждание: шанс дойти до цели A раньше цели B = dB / (dA + dB)
    rw = [abs(c["tB"] - c["close"]) / (abs(c["tA"] - c["close"]) + abs(c["tB"] - c["close"]))
          for c in decided if c["tA"] is not None and c["tB"] is not None]
    rwp = sum(rw) / len(rw) if rw else None
    got = w / (w + l) if w + l else None
    diff = f"{100 * (got - exp):+.0f} п.п." if got is not None and exp is not None else "—"
    diff2 = f"{100 * (got - rwp):+.0f} п.п." if got is not None and rwp is not None else "—"
    return (f"| {name} | {n} | {w} | {l} | {cnt['BOTH']} | {cnt['NONE']} | {pct(w, w + l)} | "
            f"{f'{100 * exp:.0f}%' if exp is not None else '—'} | {diff} | "
            f"{f'{100 * rwp:.0f}%' if rwp is not None else '—'} | {diff2} |")


def avg(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def f0(x):
    return "—" if x is None else f"{x:.0f}"


def build(folder: Path):
    cases, races = load(folder)
    base = base_probs(races)
    days = sorted({c["day"] for c in cases} | {r["day"] for r in races})
    sig_days = sorted({c["day"] for c in cases})
    period = f"{days[0]} — {days[-1]}" if days else "—"

    L = []
    L.append("# Закреп за фракталом → куда пойдёт цена · US30 Pepperstone H1 · пилот январь 2025\n")
    L.append("> **Пилот.** Задача — проверить, что правила поняты верно и отчёт читается. "
             f"Выборка маленькая (сигналов: {len(cases)}, торговых дней: {len(days)}), **выводы не делаем**.\n")
    L.append(f"- **Период:** {period} (время везде по Минску)")
    L.append("- **Данные:** график TradingView `PEPPERSTONE:US30`, 1 час; цели — H4 / D / W / M того же графика")
    L.append("- **Расчёт:** Pine-индикатор [`pine/zakrep-fractal.pine`](../../pine/zakrep-fractal.pine) "
             "(на графике — «BT: закреп за фракталом», layout `us30_backtest`); случаи взяты из Pine Logs "
             "([`pine-logs.json`](pine-logs.json))")
    L.append("- **Правила:** [knowledge-base/US30.md](../../knowledge-base/US30.md#идея-1-закреп-за-фракталом--направление)\n")

    L.append("## Как читать\n")
    L.append("- **✅** — от закрытия свечи-сигнала цена первой дошла до ближайшей нетронутой зоны H4/D/W/M **по направлению** закрепа; "
             "**❌** — первой до ближайшей зоны **против**; **❓** — обе задеты одной часовой свечой (по H1 порядок не виден); "
             "**⏳** — до конца торгового дня ни одной.")
    L.append("- **% ✅** считается только из решённых (✅ + ❌).")
    L.append("- **База** — сколько процентов дала бы та же «гонка двух зон» без всякого сигнала: от закрытия каждой свечи тех же сессий, "
             "с тем же соотношением лонгов и шортов.")
    L.append("- **Случайное блуждание** — вторая, более строгая база: при случайном движении цены шанс первой дойти до цели по направлению "
             "равен «расстояние до цели против / сумма обоих расстояний». Она учитывает, что после закрепа ближняя цель "
             "по направлению обычно ближе. **Преимущество сетапа — это разница с обеими базами, прежде всего со второй.**\n")

    L.append("## Итог\n")
    L.append("| Сигнал | Случаев | ✅ | ❌ | ❓ | ⏳ | % ✅ | База | Разница | Случайное блуждание | Разница |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for s in ("F", "L", "U"):
        L.append(row(SESS[s], [c for c in cases if c["sess"] == s], base))
    L.append(row("**Первый сигнал дня**", [c for c in cases if c["first"]], base))
    L.append(row("**Все сигналы**", cases, base))
    L.append("")

    L.append("### Срезы\n")
    L.append("| Срез | Случаев | ✅ | ❌ | ❓ | ⏳ | % ✅ | База | Разница | Случайное блуждание | Разница |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    L.append(row("Лонги", [c for c in cases if c["dir"] == "L"], base))
    L.append(row("Шорты", [c for c in cases if c["dir"] == "S"], base))
    L.append(row("Фрактал из сегодняшней Азии", [c for c in cases if c["origin"] == "Азия сегодня"], base))
    L.append(row("Фрактал не из Азии", [c for c in cases if c["origin"] != "Азия сегодня"], base))
    L.append(row("Всё тело за уровнем", [c for c in cases if c["body"]], base))
    L.append(row("За уровнем только закрытие", [c for c in cases if not c["body"]], base))
    L.append("")

    L.append("### Базовая частота по сессиям\n")
    L.append("| Сессия | Свечей-точек | Вверх первым | Вниз первым | ❓ | ⏳ |")
    L.append("|---|---|---|---|---|---|")
    for s in ("F", "L", "U"):
        b = base[s]
        L.append(f"| {SESS[s]} | {b['n']} | {b['up']} ({pct(b['up'], b['up'] + b['dn'])}) | "
                 f"{b['dn']} ({pct(b['dn'], b['up'] + b['dn'])}) | {b['both']} | {b['none']} |")
    L.append("")

    L.append("### Расстояние до целей в момент сигнала, пункты\n")
    L.append("| Сигнал | До цели по направлению | До цели против | Цель по направлению ближе |")
    L.append("|---|---|---|---|")
    for s in ("F", "L", "U"):
        cs = [c for c in cases if c["sess"] == s and c["tA"] is not None and c["tB"] is not None]
        if not cs:
            continue
        da = [abs(c["tA"] - c["close"]) for c in cs]
        db = [abs(c["tB"] - c["close"]) for c in cs]
        closer = sum(1 for a, b in zip(da, db) if a < b)
        L.append(f"| {SESS[s]} | {f0(avg(da))} | {f0(avg(db))} | {closer} из {len(cs)} |")
    L.append("\n*Если цель по направлению систематически ближе, «гонку» выиграть легче — это видно в сравнении с базой, "
             "но стоит помнить при чтении % ✅.*\n")

    L.append("### Ход цены после сигнала, пункты\n")
    L.append("| Сигнал | Макс. ход по направлению | Макс. ход против | К концу Лондона | К концу дня | Конец дня в плюс | Обратный закреп |")
    L.append("|---|---|---|---|---|---|---|")
    for s in ("F", "L", "U"):
        cs = [c for c in cases if c["sess"] == s]
        if not cs:
            continue
        pos = sum(1 for c in cs if (c["dayMove"] or 0) > 0)
        rev = sum(1 for c in cs if c["revT"])
        lon = avg([c["lonMove"] for c in cs]) if s != "U" else None
        L.append(f"| {SESS[s]} | {f0(avg([c['mfe'] for c in cs]))} | {f0(avg([c['mae'] for c in cs]))} | "
                 f"{f0(lon)} | {f0(avg([c['dayMove'] for c in cs]))} | {pos} из {len(cs)} | {rev} из {len(cs)} |")
    L.append("\n*Средние значения. «Обратный закреп» — часовое тело закрылось обратно за уровень фрактала до конца дня.*\n")

    # 13. Разворот в США после отработки утреннего сигнала
    by_day = defaultdict(list)
    for c in cases:
        by_day[c["day"]].append(c)
    morning_win = [(d, cs) for d, cs in by_day.items()
                   if any(c["sess"] in ("F", "L") and c["res"] == "WIN" for c in cs)]
    rev_us = 0
    for d, cs in morning_win:
        mdir = next(c["dir"] for c in cs if c["sess"] in ("F", "L") and c["res"] == "WIN")
        if any(c["sess"] == "U" and c["dir"] != mdir for c in cs):
            rev_us += 1
    L.append("### Разворот в США\n")
    L.append(f"Дней, когда сигнал Франкфурта или Лондона дошёл до цели: **{len(morning_win)}**. "
             f"Из них США дали закреп в обратную сторону: **{rev_us}**.\n")

    no_sig = [d for d in days if d not in sig_days]
    L.append(f"Дней без единого сигнала: **{len(no_sig)}**{(' (' + ', '.join(no_sig) + ')') if no_sig else ''}.\n")

    L.append("## Все случаи\n")
    L.append("Картинка дня — скриншот графика TradingView с индикатором: серым Азия, фиолетовым Франкфурт, зелёным Лондон, "
             "голубым США; оранжевая линия — уровень фрактала, пунктир — цели (зелёный по направлению, красный против) "
             "с подписью таймфрейма. Сверить можно на своём графике по дате и времени.\n")
    L.append("| Дата, время | Сессия | Направление | Закрытие | Уровень (откуда) | Цель по направлению | Цель против | Итог | Ход +/− | Картинка |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for c in cases:
        ta = f"{c['tA']:.1f} {c['tfA']} {KIND.get(c['kA'], '')}" if c["tA"] is not None else "нет"
        tb = f"{c['tB']:.1f} {c['tfB']} {KIND.get(c['kB'], '')}" if c["tB"] is not None else "нет"
        res = RES_ICON[c["res"]] + (f" {c['resT'][11:]}" if c["resT"] else "")
        flags = (" · первый" if c["first"] else "") + (" · конфликт" if c["conflict"] else "")
        day = c["day"]
        img = f"[{day}](#{day})" if (folder / "days" / f"{day}.png").exists() else "—"
        L.append(f"| {c['t']} | {SESS[c['sess']]}{flags} | {'лонг' if c['dir'] == 'L' else 'шорт'} | {c['close']:.1f} | "
                 f"{c['lvl']:.1f} ({c['origin']}, {c['lvlT'][11:]}) | {ta} | {tb} | {res} | "
                 f"{f0(c['mfe'])} / {f0(c['mae'])} | {img} |")
    L.append("")

    L.append("## По дням\n")
    L.append("Серым — Азия, фиолетовым — Франкфурт, зелёным — Лондон, голубым — США. Оранжевая линия — уровень фрактала, "
             "зелёный пунктир — цель по направлению, красный — цель против (подпись у правого края). "
             "Метки F/L/U — сигналы сессий, ✅❌ — какая цель задета первой. Время на шкале — по Минску.\n")
    for day in sig_days:
        if not (folder / "days" / f"{day}.png").exists():
            continue
        L.append(f'<a id="{day}"></a>\n')
        L.append(f"### {day}\n")
        for c in by_day[day]:
            L.append(f"- {c['t'][11:]} {SESS[c['sess']]} — {'лонг' if c['dir'] == 'L' else 'шорт'} "
                     f"за уровнем {c['lvl']:.1f} ({c['origin']}) → {RES_ICON[c['res']]}"
                     + (f" в {c['resT'][11:]}" if c["resT"] else ""))
        L.append(f"\n![{day}](days/{day}.png)\n")

    L.append("## Ограничения этого прогона\n")
    L.append("- Пилот на одном месяце — только проверка правил и вида отчёта.")
    L.append("- История H1 на тарифе TradingView Essential ≈ 10 000 свечей; для 2 января нет свечей предыдущего дня, "
             "поэтому фракталы «вчера» в этот день недоступны.")
    L.append("- Порядок касаний внутри одной часовой свечи не виден: такие случаи помечены ❓.")
    L.append("- Цели — только нетронутые на момент сигнала фракталы и имбалансы H4/D/W/M; задетая зона больше не цель.")
    (folder / "README.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    (folder / "cases.json").write_text(json.dumps({"cases": cases, "base": base}, ensure_ascii=False, indent=1), encoding="utf-8")
    return cases, races, base


if __name__ == "__main__":
    cs, rs, b = build(Path(sys.argv[1]))
    print(f"cases={len(cs)} races={len(rs)}")
    print(json.dumps({k: {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in b.items()}, ensure_ascii=False))
