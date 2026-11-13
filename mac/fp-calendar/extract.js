// Выполняется внутри страницы календаря FundingPips в Safari пользователя.
// Возвращает JSON-строку: состояние страницы и строки календаря с отметкой,
// по каким признакам событие помечено замочком (Restricted).
//
// Разметку их кабинета мы не видели — он закрыт от ботов. Поэтому скрипт ничего
// не решает сам: отдаёт текст строк и все значки внутри строки, а что из них
// означает «Restricted», решает сервер. Так правку можно сделать на сервере,
// не трогая Мак.
(() => {
  const text = el => (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const out = {
    url: location.href,
    title: document.title,
    state: 'ok',
    rows: [],
    days: [],
    sample: ''
  };

  if (/Checkpoint/i.test(document.title)) { out.state = 'blocked'; return JSON.stringify(out); }
  if (/sign-?in|login/i.test(location.pathname) || /Sign in to your account/i.test(document.body.innerText)) {
    out.state = 'logged_out';
    return JSON.stringify(out);
  }

  const timeRe = /^\d{1,2}:\d{2}\s*(AM|PM)?$/i;
  const dayRe = /^(Today|Tomorrow|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;

  // Обходим ТЕКСТ в порядке документа: заголовок дня задаёт день для строк под ним.
  // Именно текстовые узлы, а не элементы без детей: у FundingPips в ячейку со временем
  // вложены значки (красная точка, замочек Restricted), и первая версия, искавшая
  // «листья», не нашла ни одной строки (13.11.2026).
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let day = '';
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = (node.textContent || '').trim();
    if (!t || !node.parentElement) continue;
    if (dayRe.test(t) && t.length < 30) { day = t; if (!out.days.includes(t)) out.days.push(t); continue; }
    if (!timeRe.test(t)) continue;

    // Поднимаемся до строки таблицы: первый предок, где есть код валюты.
    let row = node.parentElement;
    for (let i = 0; i < 8 && row.parentElement; i++) {
      if (text(row).some(l => /^[A-Z]{3}$/.test(l))) break;
      row = row.parentElement;
    }
    if (seen.has(row)) continue;
    seen.add(row);

    const icons = [...row.querySelectorAll('svg, img, [aria-label], [title], [data-state], [class*="lock" i], [class*="restrict" i]')]
      .map(n => [
        n.tagName.toLowerCase(),
        (n.getAttribute('class') || '').slice(0, 80),
        n.getAttribute('aria-label') || '',
        n.getAttribute('title') || '',
        n.getAttribute('data-state') || '',
        n.getAttribute('data-testid') || ''
      ].join('~').slice(0, 160));

    out.rows.push({ day, text: text(row).slice(0, 8).join(' | ').slice(0, 220), icons: icons.slice(0, 8) });
    if (!out.sample) out.sample = row.outerHTML.replace(/\s+/g, ' ').slice(0, 2500);
  }

  if (!out.rows.length) {
    // Ни одной строки: либо событий правда нет, либо страница не успела отрисоваться.
    // Отличить помогает текст — пусть сервер посмотрит.
    out.state = 'empty';
    out.sample = document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500);
  }
  return JSON.stringify(out);
})();
