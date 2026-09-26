"""Markdown отчётов и базы знаний → HTML рядом с исходником, чтобы смотреть в браузере вместе с картинками.

Понимает только то, что пишут наши отчёты: заголовки, абзацы, списки, таблицы, цитаты, картинки,
**жирный**, *курсив*, `код`, [ссылки](...). Ссылки на .md переписываются на .html.

    python3 tools/md2html.py reports/2025-01_zakrep-fractal/README.md knowledge-base/US30.md
"""
import html
import re
import sys
from pathlib import Path

CSS = """
:root { --bg:#ffffff; --fg:#1d1d1f; --muted:#6e6e73; --line:#d9d9de; --head:#f4f4f6; --link:#0a66c2; --quote:#f7f3e8; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1c1e; --fg:#f2f2f7; --muted:#a1a1a6; --line:#3a3a3c; --head:#2c2c2e; --link:#5ea8ff; --quote:#2e2a20; } }
body { background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin:0; }
main { max-width:1400px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:26px; } h2 { font-size:21px; margin-top:36px; border-bottom:1px solid var(--line); padding-bottom:4px; } h3 { font-size:17px; margin-top:28px; }
a { color:var(--link); }
code { background:var(--head); padding:1px 5px; border-radius:4px; font-size:13px; }
blockquote { background:var(--quote); margin:12px 0; padding:8px 14px; border-radius:6px; }
.tbl { overflow-x:auto; }
table { border-collapse:collapse; margin:10px 0; font-size:14px; }
th, td { border:1px solid var(--line); padding:5px 9px; text-align:left; vertical-align:top; }
th { background:var(--head); }
img { max-width:100%; border:1px solid var(--line); border-radius:6px; }
em { color:var(--muted); }
"""


def link_target(url: str) -> str:
    return re.sub(r"\.md(#|$)", r".html\1", url)


def inline(s: str) -> str:
    out, pos = [], 0
    # картинки и ссылки обрабатываем до экранирования, остальное экранируем
    for m in re.finditer(r"!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`", s):
        out.append(fmt(html.escape(s[pos:m.start()])))
        if m.group(2) is not None:
            out.append(f'<img alt="{html.escape(m.group(1))}" src="{html.escape(m.group(2))}" loading="lazy">')
        elif m.group(4) is not None:
            out.append(f'<a href="{html.escape(link_target(m.group(4)))}">{inline(m.group(3))}</a>')
        else:
            out.append(f"<code>{html.escape(m.group(5))}</code>")
        pos = m.end()
    out.append(fmt(html.escape(s[pos:])))
    return "".join(out)


def fmt(s: str) -> str:
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    return re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"<em>\1</em>", s)


def cells(line: str):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert(md: str, title: str) -> str:
    lines = md.splitlines()
    out, i, para = [], 0, []

    def flush():
        if para:
            out.append("<p>" + " ".join(inline(p) for p in para) + "</p>")
            para.clear()

    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            flush(); i += 1; continue
        if s.startswith("<"):
            flush(); out.append(s); i += 1; continue
        m = re.match(r"(#{1,4}) (.*)", s)
        if m:
            flush()
            n = len(m.group(1))
            text = m.group(2)
            anchor = re.sub(r"[^\w\- ]", "", text.lower()).strip().replace(" ", "-")
            out.append(f'<h{n} id="{html.escape(anchor)}">{inline(text)}</h{n}>'); i += 1; continue
        if s.startswith("|"):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i]); i += 1
            head, body = cells(rows[0]), [cells(r) for r in rows[2:]]
            out.append('<div class="tbl"><table><thead><tr>' + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>")
            for r in body:
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
            out.append("</tbody></table></div>"); continue
        if s.startswith(">"):
            flush()
            q = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                q.append(lines[i].strip().lstrip(">").strip()); i += 1
            out.append("<blockquote>" + " ".join(inline(x) for x in q) + "</blockquote>"); continue
        m = re.match(r"(- |\d+\. )", s)
        if m:
            flush()
            tag = "ul" if s.startswith("- ") else "ol"
            items = []
            while i < len(lines) and lines[i].strip():
                t = lines[i].strip()
                mm = re.match(r"(- |\d+\. )(.*)", t)
                if mm and not lines[i].startswith("   "):
                    items.append(mm.group(2))
                else:
                    items[-1] += " " + t
                i += 1
            out.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>"); continue
        if s == "---":
            flush(); out.append("<hr>"); i += 1; continue
        para.append(s); i += 1
    flush()
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>{html.escape(title)}</title><style>{CSS}</style></head><body><main>"
            + "\n".join(out) + "</main></body></html>\n")


def build(path: Path) -> Path:
    md = path.read_text(encoding="utf-8")
    m = re.search(r"^# (.+)$", md, re.M)
    out = path.with_suffix(".html")
    out.write_text(convert(md, m.group(1) if m else path.stem), encoding="utf-8")
    return out


if __name__ == "__main__":
    for a in sys.argv[1:]:
        print(build(Path(a)))
