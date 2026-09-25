/*** Trade Journal — Apps Script ***/

var PROPS = ['Instant', '100k challenge', 'FundingPips'];
var PROP_DEFAULT_BALANCE = {
  'Instant': 50000,
  '100k challenge': 100000,
  'FundingPips': 100000
};

var PROP_START_COL = 22;   // V
var COLS_PER_PROP = 4;     // Risk %, $, %, RR

var COL_TAKESTOP   = 15;   // O (устаревшее)
var COL_RISK_OLD   = 16;   // P (устаревшее)
var COL_RR_OLD     = 17;   // Q (устаревшее)
var COL_RESULT     = 18;   // R — скрин закрытия, 5 минут
var COL_RESULT_1H  = 19;   // S — скрин закрытия, 1 час
var COL_ERRORS     = 7;    // G — ошибки после сделки / выводы
var COL_GRADE      = 20;   // T — оценка позиции (A / A (-) / B / C)
var COL_ACCOUNT_OLD = 21;  // U — аккаунт (историческое)

var PROPS_SHEET = 'Props';
var STATS_SHEET = 'Статистика';
var PROPS_MAX_ROW = 50;
var BALANCES_SHEET = 'Балансы';
var BALANCES_MAX_ROW = 200;

/*** Утилиты ***/

function getTradesSheet(ss) {
  return ss.getSheetByName('Traders')
      || ss.getSheetByName('Trades')
      || ss.getSheets()[0];
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

// Ссылка на скрин или ничего. 25.09 TradingView ушёл на обслуживание, отдал вместо
// номера снимка HTML-страницу, и она целиком уехала в ячейку закрытия. Журнал —
// последний рубеж: что не похоже на короткую ссылку, в него не попадает.
function cleanLink(value) {
  if (isEmpty(value)) return '';
  var text = String(value).trim();
  if (text.length > 300) return '';
  if (/[<>\s]/.test(text)) return '';
  if (!/^https?:\/\//.test(text)) return '';
  return text;
}

function fmt(value, tz, pattern) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, pattern);
  return String(value || '');
}

function totalUsdCol() {
  return PROP_START_COL + PROPS.length * COLS_PER_PROP;
}

function propCols(i) {
  var base = PROP_START_COL + i * COLS_PER_PROP;
  return { risk: base, usd: base + 1, pct: base + 2, rr: base + 3 };
}

// Момент закрытия по каждому пропу — скрытые колонки после «Итого $».
// Нужен, чтобы сделка, открытая до фиксации баланса и закрытая после, попала
// в «P&L после»: дата в колонке A — это момент открытия.
function closeCol(i) {
  return totalUsdCol() + 1 + i;
}

function lastDataCol() {
  return closeCol(PROPS.length - 1);
}

function propIndexByName(name) {
  var needle = String(name || '').trim().toLowerCase();
  for (var i = 0; i < PROPS.length; i++) {
    if (PROPS[i].toLowerCase() === needle) return i;
  }
  return -1;
}

function a1col(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (isEmpty(value)) return null;
  var s = String(value).replace(/\s/g, '').replace(',', '.').replace('+', '');
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/*** Роутер ***/

function doPost(e) {
  try {
    if (!e || !e.postData) return createResponse(false, 'No postData');

    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getTradesSheet(ss);
    detectArgSep(ss);

    if (!sheet) {
      var names = ss.getSheets().map(function (s) { return s.getName(); }).join(', ');
      return createResponse(false, 'Sheet not found. Available: ' + names);
    }

    Logger.log('Action: ' + (data.action || 'new trade'));

    // Идемпотентность: ответ Apps Script иногда приходит боту HTML-страницей
    // при успешно выполненной записи. Бот повторяет запрос с тем же requestId —
    // второй раз ничего не пишем, отдаём сохранённый ответ.
    var cache = CacheService.getScriptCache();
    var cacheKey = data.requestId ? 'req_' + String(data.requestId).slice(0, 200) : null;

    if (cacheKey) {
      var cached = cache.get(cacheKey);
      if (cached) {
        var prev = JSON.parse(cached);
        prev.replayed = true;
        return ContentService.createTextOutput(JSON.stringify(prev))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (data.action === 'getOpenTrades') return getOpenTrades(sheet);
    if (data.action === 'getStats')      return getStats(ss, sheet);
    if (data.action === 'setBalance')    return remember(cache, cacheKey, setBalance(ss, data));
    if (data.action === 'undoBalance')   return undoBalance(ss, data);
    if (data.action === 'deletePropsRow') return deletePropsRow(ss, data);
    if (data.action === 'updateTrade')   return remember(cache, cacheKey, updateTradeResult(sheet, data));
    if (data.action === 'setup')         return runSetup(ss, sheet);
    if (data.action === 'dump')          return dumpSheet(sheet, data);
    if (data.action === 'headers')       { buildHeaders(sheet); return createResponse(true, 'headers rebuilt'); }
    if (data.action === 'ping') {
      // sizes — размер аккаунта из Props на сейчас: бот пересчитывает риск $ → %
      var sizes = {};
      PROPS.forEach(function (name) { sizes[name] = balanceFor(ss, name, new Date()); });
      return createResponse(true, 'pong', {
        props: PROPS,
        sizes: sizes,
        timezone: ss.getSpreadsheetTimeZone(),
        locale: ss.getSpreadsheetLocale(),
        argSep: ARG_SEP,
        maxColumns: sheet.getMaxColumns()
      });
    }
    if (data.action === 'fixDatesOnce')  return fixDatesOnce(ss, sheet);
    if (data.action === 'deleteTestRow') return deleteTestRow(sheet, data);
    if (data.action === 'setScreenshots') return remember(cache, cacheKey, setScreenshots(sheet, data));
    if (data.action === 'clearCells')    return clearCells(sheet, data);
    if (data.action === 'addResult1hColumn') return addResult1hColumn(ss, sheet);
    if (data.action === 'setTimezone') {
      ss.setSpreadsheetTimeZone(data.timezone);
      return createResponse(true, 'timezone set', { timezone: ss.getSpreadsheetTimeZone() });
    }
    return remember(cache, cacheKey, addNewTrade(sheet, data));
  } catch (error) {
    Logger.log('Error: ' + error);
    return createResponse(false, error.toString() + ' | ' + (error.stack || ''));
  }
}

// Кладёт успешный ответ в кэш под requestId (6 часов) и возвращает его как есть
function remember(cache, cacheKey, output) {
  if (cacheKey) {
    var text = output.getContent();
    try {
      if (JSON.parse(text).success === true) cache.put(cacheKey, text, 21600);
    } catch (e) {}
  }
  return output;
}

function createResponse(success, message, data) {
  var response = { success: success, message: message };
  if (data) response.data = data;
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/*** Диагностика ***/

// Удаляет строку только если пара начинается с TEST- — защита от случайного
// удаления настоящей сделки при тестировании.
function deleteTestRow(sheet, data) {
  var row = Number(data.row);
  if (!row || row < 2 || row > sheet.getLastRow()) return createResponse(false, 'bad row');

  var pair = String(sheet.getRange(row, 4).getValue());
  var thoughts = String(sheet.getRange(row, 5).getValue());

  // Тестовой считаем строку с парой TEST-… или с маркером в «Мыслях» (data.match).
  // Маркер нужен, когда тест гоняется на настоящем символе: в авторежиме бот берёт
  // пару из ссылки TradingView, подменить её на TEST- нельзя.
  var isTest = pair.indexOf('TEST-') === 0
    || (!isEmpty(data.match) && thoughts.indexOf(String(data.match)) !== -1);
  if (!isTest) return createResponse(false, 'row ' + row + ' is not a test row: ' + pair);

  sheet.deleteRow(row);
  return createResponse(true, 'deleted', { row: row, pair: pair });
}

// Дозаполняет скрины таймфреймов (I–N) в уже записанной строке. Нужно, когда съёмщик
// не справился в момент записи и скрины добираются потом командой /shots.
// row: номер строки или 'last'. Занятые ячейки не трогаем, пока не передан overwrite.
// Одноразовая миграция: вставляет колонку «Скрин закрытия 1ч» сразу после скрина
// закрытия, чтобы два скрина лежали рядом. Всё правее — оценка, аккаунты и блок
// пропов — сдвигается на колонку, поэтому следом перестраиваем шапку, формулы и
// статистику. Повторный вызов ничего не делает.
function addResult1hColumn(ss, sheet) {
  if (String(sheet.getRange(1, COL_RESULT_1H).getValue()).indexOf('1ч') !== -1) {
    return createResponse(true, 'уже сделано');
  }

  sheet.insertColumnAfter(COL_RESULT);
  buildHeaders(sheet);
  var rows = applyAllFormulas(sheet);
  formatSheet(sheet);
  var months = buildStats(ss, sheet);

  return createResponse(true, 'колонка добавлена', {
    formulas: rows, months: months, lastCol: sheet.getLastColumn()
  });
}

// Точечно стереть ячейки: { row: 58, cols: ['S'] }. Нужно, когда в журнал
// всё-таки попало что-то негодное и это надо убрать, не трогая соседние колонки.
function clearCells(sheet, data) {
  var row = String(data.row) === 'last' ? sheet.getLastRow() : Number(data.row);
  if (!row || row < 2 || row > sheet.getLastRow()) return createResponse(false, 'bad row');

  var cols = data.cols || [];
  var cleared = [];
  cols.forEach(function (name) {
    var col = colIndex(name);
    if (!col) return;
    sheet.getRange(row, col).clearContent();
    cleared.push(name);
  });

  return createResponse(true, 'cleared', { row: row, cleared: cleared });
}

function colIndex(name) {
  var text = String(name).toUpperCase().replace(/[^A-Z]/g, '');
  if (!text) return 0;
  var n = 0;
  for (var i = 0; i < text.length; i++) n = n * 26 + (text.charCodeAt(i) - 64);
  return n;
}

function setScreenshots(sheet, data) {
  var row = String(data.row) === 'last' ? sheet.getLastRow() : Number(data.row);
  if (!row || row < 2 || row > sheet.getLastRow()) return createResponse(false, 'bad row');

  var links = data.links || {};
  var cells = [[9, links.h1], [10, links.h4], [11, links.d1],
               [12, links.dxy1h], [13, links.dxy4h], [14, links.dxy1d],
               [COL_RESULT, links.close5m], [COL_RESULT_1H, links.close1h]];
  var written = [];
  var skipped = [];

  cells.forEach(function (cell) {
    cell[1] = cleanLink(cell[1]);
    if (isEmpty(cell[1])) return;
    if (!data.overwrite && !isEmpty(sheet.getRange(row, cell[0]).getValue())) {
      skipped.push(a1col(cell[0]));
      return;
    }
    sheet.getRange(row, cell[0]).setValue(cell[1]);
    written.push(a1col(cell[0]));
  });

  return createResponse(true, 'screenshots set', {
    row: row,
    pair: String(sheet.getRange(row, 4).getValue()),
    written: written,
    skipped: skipped
  });
}

function dumpSheet(sheet, data) {
  var values = sheet.getDataRange().getValues();
  var rows = Number(data.rows || 3);
  // from — с какой строки таблицы начать (1-based). По умолчанию с шапки.
  // from: 'last' отдаёт последние rows строк — так удобно смотреть свежие сделки.
  var from = String(data.from || '') === 'last' ? Math.max(1, values.length - rows + 1)
           : Math.max(1, Number(data.from || 1));
  var width = Math.min(2000, Number(data.width || 40));   // сколько символов ячейки показывать
  var out = [];

  for (var i = from - 1; i < Math.min(values.length, from - 1 + rows + (from === 1 ? 1 : 0)); i++) {
    var row = [];
    for (var j = 0; j < values[i].length; j++) {
      var v = values[i][j];
      var type = v instanceof Date ? 'Date' : typeof v;
      row.push(a1col(j + 1) + ':' + type + ':' + String(v).slice(0, width));
    }
    out.push(row);
  }

  return createResponse(true, 'dump', {
    sheet: sheet.getName(),
    lastRow: sheet.getLastRow(),
    lastCol: sheet.getLastColumn(),
    sheets: sheet.getParent().getSheets().map(function (s) { return s.getName(); }),
    rows: out
  });
}

/*** Балансы пропов ***/

function ensurePropsSheet(ss) {
  var sheet = ss.getSheetByName(PROPS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(PROPS_SHEET);
  }

  if (sheet.getLastRow() < 2) {
    sheet.getRange('A1:C1').setValues([['Проп', 'Баланс', 'Действует с']]);
    var rows = PROPS.map(function (name) {
      return [name, PROP_DEFAULT_BALANCE[name] || 0, new Date(2026, 0, 1)];
    });
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  } else {
    // добиваем пропы, которых ещё нет
    var existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .map(function (r) { return String(r[0]).trim().toLowerCase(); });

    PROPS.forEach(function (name) {
      if (existing.indexOf(name.toLowerCase()) === -1) {
        sheet.appendRow([name, PROP_DEFAULT_BALANCE[name] || 0, new Date(2026, 0, 1)]);
      }
    });
  }

  sheet.getRange('A1:C1').setFontWeight('bold').setBackground('#37474F').setFontColor('white');
  sheet.getRange(2, 2, PROPS_MAX_ROW, 1).setNumberFormat('#,##0');
  sheet.getRange(2, 3, PROPS_MAX_ROW, 1).setNumberFormat('dd.MM.yyyy');
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(3, 120);

  // сортировка по дате — от неё зависит поиск «последнего действующего баланса»
  if (sheet.getLastRow() > 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).sort([{ column: 1 }, { column: 3 }]);
  }

  return sheet;
}

// Баланс пропа, действующий на дату: последняя строка Props с «Действует с» <= date
function balanceInfoFor(ss, propName, date) {
  var sheet = ss.getSheetByName(PROPS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { balance: null, from: null };

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var when = (date instanceof Date) ? date : new Date();
  var best = null;
  var bestDate = null;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() !== String(propName).trim().toLowerCase()) continue;

    var from = values[i][2];
    if (!(from instanceof Date)) continue;
    if (from > when) continue;

    if (!bestDate || from > bestDate) {
      bestDate = from;
      best = Number(values[i][1]);
    }
  }

  return { balance: best, from: bestDate };
}

function balanceFor(ss, propName, date) {
  return balanceInfoFor(ss, propName, date).balance;
}

/*** Фактический баланс — лист «Балансы» ***/
// Props = РАЗМЕР аккаунта (база для %), меняется только при смене аккаунта.
// «Балансы» = фиксации фактического баланса с точным временем (/balance в боте).
// Текущий баланс = последняя фиксация + сумма $ по сделкам, ЗАКРЫТЫМ после неё
// (момент закрытия — closeCol; если его нет, берётся дата открытия из A).

function ensureBalancesSheet(ss) {
  var sheet = ss.getSheetByName(BALANCES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BALANCES_SHEET);
    sheet.getRange('A1:C1').setValues([['Проп', 'Баланс', 'Зафиксирован']])
      .setFontWeight('bold').setBackground('#37474F').setFontColor('white');
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(3, 160);
  }
  sheet.getRange(2, 2, BALANCES_MAX_ROW, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 3, BALANCES_MAX_ROW, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  return sheet;
}

// Последняя фиксация баланса пропа не позже момента `when`
function balanceSnapshotFor(ss, propName, when) {
  var sheet = ss.getSheetByName(BALANCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var best = null;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() !== String(propName).trim().toLowerCase()) continue;
    var at = values[i][2];
    if (!(at instanceof Date) || at > when) continue;
    if (!best || at > best.at) best = { balance: Number(values[i][1]), at: at };
  }
  return best;
}

// /balance: фиксирует фактический баланс на текущий момент (или data.at — ISO-строка)
function setBalance(ss, data) {
  var idx = propIndexByName(data.name);
  if (idx === -1) return createResponse(false, 'Неизвестный проп: ' + data.name);

  var balance = toNumber(data.balance);
  if (balance === null || balance <= 0) return createResponse(false, 'Некорректный баланс: ' + data.balance);

  var at = data.at ? new Date(data.at) : new Date();
  if (isNaN(at.getTime())) return createResponse(false, 'Некорректное время: ' + data.at);

  var sheet = ensureBalancesSheet(ss);
  sheet.appendRow([PROPS[idx], balance, at]);
  sheet.getRange(sheet.getLastRow(), 3).setNumberFormat('dd.MM.yyyy HH:mm');

  var tz = ss.getSpreadsheetTimeZone();
  return createResponse(true, 'Balance set', {
    name: PROPS[idx],
    balance: balance,
    at: Utilities.formatDate(at, tz, 'dd.MM.yyyy HH:mm')
  });
}

// Откат: удаляет последнюю фиксацию пропа
function undoBalance(ss, data) {
  var idx = propIndexByName(data.name);
  if (idx === -1) return createResponse(false, 'Неизвестный проп: ' + data.name);

  var sheet = ss.getSheetByName(BALANCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return createResponse(false, 'no snapshots');

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var bestRow = -1, bestAt = null;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() !== PROPS[idx].toLowerCase()) continue;
    if (values[i][2] instanceof Date && (!bestAt || values[i][2] > bestAt)) { bestAt = values[i][2]; bestRow = i + 2; }
  }
  if (bestRow === -1) return createResponse(false, 'no snapshots for ' + PROPS[idx]);

  sheet.deleteRow(bestRow);
  return createResponse(true, 'deleted', { name: PROPS[idx], row: bestRow });
}

// Служебное: удалить строку Props (размер аккаунта) по пропу и дате yyyy-MM-dd
function deletePropsRow(ss, data) {
  var idx = propIndexByName(data.name);
  if (idx === -1) return createResponse(false, 'Неизвестный проп: ' + data.name);

  var sheet = ss.getSheetByName(PROPS_SHEET);
  var tz = ss.getSpreadsheetTimeZone();
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();

  for (var i = values.length - 1; i >= 0; i--) {
    var sameProp = String(values[i][0]).trim().toLowerCase() === PROPS[idx].toLowerCase();
    var sameDate = values[i][2] instanceof Date && Utilities.formatDate(values[i][2], tz, 'yyyy-MM-dd') === String(data.date);
    if (sameProp && sameDate) {
      sheet.deleteRow(i + 2);
      return createResponse(true, 'deleted', { name: PROPS[idx], date: data.date });
    }
  }
  return createResponse(false, 'row not found');
}

/*** Сводка для /stats в боте ***/

// Баланс пропа на момент `when`: последняя фиксация не позже него + $ сделок,
// закрытых после фиксации и не позже `when`. Без фиксаций — размер аккаунта
// с даты «Действует с». Момент закрытия — closeCol, у старых строк — дата открытия.
function balanceAt(ss, values, p, when) {
  var size = balanceInfoFor(ss, PROPS[p], when);
  var snap = balanceSnapshotFor(ss, PROPS[p], when);
  var base = snap ? snap.balance : size.balance;
  var since = snap ? snap.at : size.from;
  if (base === null || !since) return null;

  var c = propCols(p);
  var sum = 0;

  for (var i = 1; i < values.length; i++) {
    var date = values[i][0];
    if (!(date instanceof Date) || isEmpty(values[i][3])) continue;
    if (isEmpty(values[i][c.risk - 1]) || isEmpty(values[i][c.usd - 1])) continue;

    var closedRaw = values[i][closeCol(p) - 1];
    var closedAt = closedRaw instanceof Date ? closedRaw : date;
    if (closedAt > when) continue;
    if (snap ? closedAt > since : closedAt >= since) sum += toNumber(values[i][c.usd - 1]) || 0;
  }

  return base + sum;
}

// Месяц считается ОТ БАЛАНСА: текущий − баланс на 1-е число. Сумма $ по сделкам
// журнала для этого не используется — журнал может быть неполным, счёт — нет.
function getStats(ss, sheet) {
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();
  var monthKey = Utilities.formatDate(now, tz, 'yyyy-MM');
  var monthStart = Utilities.parseDate(monthKey + '-01 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss');
  var values = sheet.getDataRange().getValues();
  var props = [];

  for (var p = 0; p < PROPS.length; p++) {
    var c = propCols(p);
    var size = balanceInfoFor(ss, PROPS[p], now);
    var snap = balanceSnapshotFor(ss, PROPS[p], now);
    var current = balanceAt(ss, values, p, now);
    var atMonthStart = balanceAt(ss, values, p, monthStart);

    var stat = {
      name: PROPS[p],
      accountSize: size.balance,
      snapshotBalance: snap ? snap.balance : null,
      snapshotAt: snap ? Utilities.formatDate(snap.at, tz, 'dd.MM.yyyy HH:mm') : null,
      pnlSince: (current !== null && snap) ? current - snap.balance : 0,
      currentBalance: current,
      monthStartBalance: atMonthStart,
      monthUsd: (current !== null && atMonthStart !== null) ? current - atMonthStart : null,
      monthPct: null,
      monthTrades: 0,
      monthWins: 0,
      open: 0
    };

    if (stat.monthUsd !== null && size.balance) stat.monthPct = stat.monthUsd / size.balance * 100;

    // счётчики сделок — из журнала (по дате открытия)
    for (var i = 1; i < values.length; i++) {
      var date = values[i][0];
      if (!(date instanceof Date) || isEmpty(values[i][3]) || isEmpty(values[i][c.risk - 1])) continue;

      var usd = values[i][c.usd - 1];
      if (isEmpty(usd)) { stat.open++; continue; }

      if (Utilities.formatDate(date, tz, 'yyyy-MM') === monthKey) {
        stat.monthTrades++;
        if ((toNumber(usd) || 0) > 0) stat.monthWins++;
      }
    }

    props.push(stat);
  }

  return createResponse(true, 'stats', { month: monthKey, props: props });
}

/*** Формулы ***/

// Apps Script ставит формулы в локали таблицы: в ru_RU аргументы разделяются «;»,
// а «,» — десятичный разделитель (=SUM(1,2) даёт 1.2). Формулы ниже пишутся
// с запятыми и без десятичных дробей, а loc() подставляет нужный разделитель.
var ARG_SEP = ',';

function detectArgSep(ss) {
  var locale = String(ss.getSpreadsheetLocale() || 'en').toLowerCase();
  var semicolonLocales = /^(ru|be|uk|de|fr|es|it|pl|pt|nl|tr|cs|sk|hu|ro|bg|sv|da|fi|no|nb|el|hr|sl|sr|lt|lv|et|id|vi)/;
  ARG_SEP = semicolonLocales.test(locale) ? ';' : ',';
  return ARG_SEP;
}

function loc(formula) {
  return ARG_SEP === ',' ? formula : formula.split(',').join(ARG_SEP);
}

function pctFormula(row, propIndex) {
  var c = propCols(propIndex);
  var usd = '$' + a1col(c.usd) + row;
  var name = PROPS[propIndex].replace(/"/g, '""');

  // баланс = строка Props этого пропа с максимальной датой «Действует с» <= даты сделки.
  // MAXIFS + SUMIFS не зависят от порядка строк в Props (в отличие от LOOKUP).
  var P = PROPS_SHEET + '!';
  var effDate = 'MAXIFS(' + P + '$C:$C,' + P + '$A:$A,"' + name + '",' + P + '$C:$C,"<="&$A' + row + ')';
  var balance = 'SUMIFS(' + P + '$B:$B,' + P + '$A:$A,"' + name + '",' + P + '$C:$C,' + effDate + ')';

  return loc('=IF(' + usd + '="","",IFERROR(' + usd + '/' + balance + '*100,""))');
}

function rrFormula(row, propIndex) {
  var c = propCols(propIndex);
  var pct = '$' + a1col(c.pct) + row;
  var risk = '$' + a1col(c.risk) + row;

  return loc('=IF(OR(' + pct + '="",' + risk + '="",' + risk + '=0),"",' + pct + '/' + risk + ')');
}

function totalFormula(row) {
  var refs = PROPS.map(function (_, i) {
    return '$' + a1col(propCols(i).usd) + row;
  }).join(',');

  return loc('=IF(COUNT(' + refs + ')=0,"",SUM(' + refs + '))');
}

function applyRowFormulas(sheet, row) {
  for (var i = 0; i < PROPS.length; i++) {
    var c = propCols(i);
    sheet.getRange(row, c.pct).setFormula(pctFormula(row, i));
    sheet.getRange(row, c.rr).setFormula(rrFormula(row, i));
  }
  sheet.getRange(row, totalUsdCol()).setFormula(totalFormula(row));
}

/*** Чтение открытых сделок ***/

function getOpenTrades(sheet) {
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  var values = sheet.getDataRange().getValues();
  var openTrades = [];

  for (var i = 1; i < values.length; i++) {
    var pair = values[i][3];
    if (isEmpty(pair)) continue;

    var openProps = [];
    var closedProps = [];

    for (var p = 0; p < PROPS.length; p++) {
      var c = propCols(p);
      var risk = values[i][c.risk - 1];
      var usd  = values[i][c.usd - 1];

      if (isEmpty(risk)) continue;

      if (isEmpty(usd)) {
        openProps.push({ name: PROPS[p], risk: toNumber(risk) });
      } else {
        closedProps.push({ name: PROPS[p], risk: toNumber(risk), usd: toNumber(usd) });
      }
    }

    if (openProps.length === 0) continue;

    var dateTime = values[i][0];

    openTrades.push({
      row: i + 1,
      pair: String(pair),
      session: String(values[i][2] || ''),
      position: String(values[i][5] || ''),
      openProps: openProps,
      closedProps: closedProps,
      date: fmt(dateTime, tz, 'dd.MM.yyyy'),
      time: fmt(dateTime, tz, 'HH:mm'),
      dateTime: fmt(dateTime, tz, 'dd.MM.yyyy, HH:mm:ss')
    });
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    sheet: sheet.getName(),
    props: PROPS,
    today: Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy'),
    trades: openTrades
  })).setMimeType(ContentService.MimeType.JSON);
}

/*** Новая сделка ***/

function addNewTrade(sheet, data) {
  var now = new Date();

  // старый бот присылал скрин 1-5m в поле rating; новый — screenshot5m, а grade = оценка
  var shot5m = data.screenshot5m || (/^https?:/.test(String(data.rating || '')) ? data.rating : '');
  var grade = /^https?:/.test(String(data.rating || '')) ? '' : (data.grade || data.rating || '');

  var row = [
    now,
    data.day || '',
    data.session || '',
    data.pair || '',
    data.thoughts || '',
    data.position || '',
    data.errors || '',
    cleanLink(shot5m),
    cleanLink(data.screenshot1h),
    cleanLink(data.screenshot4h),
    cleanLink(data.screenshot1d),
    cleanLink(data.dxySmt1),
    cleanLink(data.dxySmt4),
    cleanLink(data.dxySmt1d)
  ];

  sheet.appendRow(row);
  var lastRow = sheet.getLastRow();

  sheet.getRange(lastRow, 1).setValue(now).setNumberFormat('dd.MM.yyyy, HH:mm:ss');
  if (grade) sheet.getRange(lastRow, COL_GRADE).setValue(grade);

  var accounts = data.accounts || [];

  // обратная совместимость со старым форматом { account, risk }
  if (accounts.length === 0 && data.account) {
    accounts = [{ name: data.account, risk: data.risk }];
  }

  var written = [];

  accounts.forEach(function (acc) {
    var idx = propIndexByName(acc.name);
    if (idx === -1) return;

    var c = propCols(idx);
    var risk = toNumber(acc.risk);
    sheet.getRange(lastRow, c.risk).setValue(risk === null ? '' : risk);
    written.push(PROPS[idx]);
  });

  if (written.length > 0) {
    sheet.getRange(lastRow, COL_ACCOUNT_OLD).setValue(written.join(', '));
  }

  applyRowFormulas(sheet, lastRow);

  return createResponse(true, 'Trade added', { row: lastRow, accounts: written });
}

/*** Закрытие сделки ***/

function updateTradeResult(sheet, data) {
  var values = sheet.getDataRange().getValues();
  var rowIndex = -1;

  if (data.row) {
    var i = Number(data.row) - 1;
    if (i >= 1 && i < values.length && String(values[i][3]) == String(data.pair)) rowIndex = i;
  }

  if (rowIndex === -1) {
    for (var j = values.length - 1; j >= 1; j--) {
      if (String(values[j][3]) == String(data.pair)) { rowIndex = j; break; }
    }
  }

  if (rowIndex === -1) return createResponse(false, 'Trade not found');

  var row = rowIndex + 1;

  if (cleanLink(data.result)) {
    sheet.getRange(row, COL_RESULT).setValue(cleanLink(data.result));
  }

  if (cleanLink(data.result1h)) {
    sheet.getRange(row, COL_RESULT_1H).setValue(cleanLink(data.result1h));
  }

  // выводы по сделке: при закрытии по частям дописываем, а не затираем
  if (!isEmpty(data.errors)) {
    var prevErrors = values[rowIndex][COL_ERRORS - 1];
    sheet.getRange(row, COL_ERRORS).setValue(isEmpty(prevErrors) ? data.errors : prevErrors + ' | ' + data.errors);
  }

  var results = data.results || [];
  var written = [];

  results.forEach(function (res) {
    var idx = propIndexByName(res.name);
    if (idx === -1) return;

    var usd = toNumber(res.usd);
    if (usd === null) return;

    var c = propCols(idx);
    sheet.getRange(row, c.usd).setValue(usd);
    sheet.getRange(row, closeCol(idx)).setValue(new Date());

    if (!isEmpty(res.risk) && isEmpty(values[rowIndex][c.risk - 1])) {
      sheet.getRange(row, c.risk).setValue(toNumber(res.risk));
    }

    written.push(PROPS[idx] + ': ' + usd + '$');
  });

  applyRowFormulas(sheet, row);
  SpreadsheetApp.flush();

  // читаем обратно посчитанные % и RR, чтобы бот показал их в подтверждении
  var report = [];
  results.forEach(function (res) {
    var idx = propIndexByName(res.name);
    if (idx === -1) return;
    var c = propCols(idx);
    report.push({
      name: PROPS[idx],
      usd: sheet.getRange(row, c.usd).getValue(),
      pct: sheet.getRange(row, c.pct).getValue(),
      rr: sheet.getRange(row, c.rr).getValue()
    });
  });

  return createResponse(true, 'Trade updated', { row: row, written: written, report: report });
}

/*** Перестройка таблицы ***/

function runSetup(ss, sheet) {
  var log = [];

  ensurePropsSheet(ss);
  ensureBalancesSheet(ss);
  log.push('Props/Балансы: ok');

  log.push('Даты: ' + normalizeDates(ss, sheet) + ' строк пересчитано, пояс ' + ss.getSpreadsheetTimeZone());

  buildHeaders(sheet);
  log.push('Заголовки: ok');

  var migration = migrateLegacy(ss, sheet);
  log.push('Миграция: перенесено ' + migration.migrated + ', без пропа ' + migration.unattributed.length);

  var rows = applyAllFormulas(sheet);
  log.push('Формулы: ' + rows + ' строк');

  formatSheet(sheet);
  log.push('Форматирование: ok');

  var months = buildStats(ss, sheet);
  log.push('Статистика: ' + months + ' месяцев');

  // пустой лист из первой версии бота больше не нужен
  var legacy = ss.getSheetByName('Analytics');
  if (legacy && legacy.getLastRow() <= 1) {
    ss.deleteSheet(legacy);
    log.push('Analytics: удалён');
  }

  return createResponse(true, 'Setup complete', {
    log: log,
    unattributed: migration.unattributed,
    skipped: migration.skipped
  });
}

var TARGET_TZ = 'Europe/Minsk';

// Старые строки бот писал текстом через toLocaleString на сервере (UTC), а Sheets
// распарсил их как время в часовом поясе таблицы (America/Los_Angeles). Стенные
// часы в ячейке = UTC. Переводим каждую ячейку в настоящий момент времени и
// переключаем таблицу на Минск. Выполняется один раз: пока таблица не в TARGET_TZ.
function normalizeDates(ss, sheet) {
  var currentTz = ss.getSpreadsheetTimeZone();
  var lastRow = sheet.getLastRow();

  // заголовок «1-5» Sheets превратил в дату 1 мая
  sheet.getRange('H1').setNumberFormat('@').setValue('1-5');

  if (lastRow < 2) {
    if (currentTz !== TARGET_TZ) ss.setSpreadsheetTimeZone(TARGET_TZ);
    return 0;
  }

  var range = sheet.getRange(2, 1, lastRow - 1, 1);
  var values = range.getValues();
  var changed = 0;

  if (currentTz !== TARGET_TZ) {
    for (var i = 0; i < values.length; i++) {
      var v = values[i][0];
      var wall = null;

      if (v instanceof Date) {
        wall = Utilities.formatDate(v, currentTz, 'yyyy-MM-dd HH:mm:ss');
      } else if (!isEmpty(v)) {
        var t = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (t) {
          wall = t[3] + '-' + ('0' + t[2]).slice(-2) + '-' + ('0' + t[1]).slice(-2) +
            ' ' + ('0' + t[4]).slice(-2) + ':' + t[5] + ':' + (t[6] || '00');
        }
      }

      if (!wall) continue;

      var m = wall.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
      values[i][0] = new Date(Date.UTC(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6])
      ));
      changed++;
    }

    if (changed > 0) range.setValues(values);
    ss.setSpreadsheetTimeZone(TARGET_TZ);
  }

  range.setNumberFormat('dd.MM.yyyy, HH:mm:ss');
  return changed;
}

// Одноразовая коррекция после первого прогона normalizeDates: серийные значения
// были посчитаны ещё в поясе America/Los_Angeles, а пояс переключился на Минск
// в том же батче. Стенные часы ячейки сейчас = LA-время нужного момента.
// Защита от повторного запуска — флаг в ScriptProperties.
function fixDatesOnce(ss, sheet) {
  var store = PropertiesService.getScriptProperties();
  if (store.getProperty('DATE_FIX_DONE')) {
    return createResponse(false, 'DATE_FIX_DONE already set — второй раз запускать нельзя');
  }

  var tz = ss.getSpreadsheetTimeZone();
  var lastRow = sheet.getLastRow();
  var range = sheet.getRange(2, 1, lastRow - 1, 1);
  var values = range.getValues();
  var sample = [];
  var fixed = 0;

  for (var i = 0; i < values.length; i++) {
    var v = values[i][0];
    if (!(v instanceof Date)) continue;

    var wall = Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
    var corrected = Utilities.parseDate(wall, 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
    values[i][0] = corrected;
    fixed++;

    if (sample.length < 4) {
      sample.push(wall + ' -> ' + Utilities.formatDate(corrected, tz, 'yyyy-MM-dd HH:mm:ss'));
    }
  }

  range.setValues(values);

  // даты «Действует с» в Props тоже были записаны до смены пояса
  var propsSheet = ss.getSheetByName(PROPS_SHEET);
  if (propsSheet && propsSheet.getLastRow() >= 2) {
    var n = propsSheet.getLastRow() - 1;
    var dates = [];
    for (var k = 0; k < n; k++) dates.push([new Date(2026, 0, 1)]);
    propsSheet.getRange(2, 3, n, 1).setValues(dates);
  }

  SpreadsheetApp.flush();
  store.setProperty('DATE_FIX_DONE', '1');

  return createResponse(true, 'dates fixed', { fixed: fixed, sample: sample, timezone: tz });
}

function ensureColumns(sheet, needed) {
  var max = sheet.getMaxColumns();
  if (max < needed) sheet.insertColumnsAfter(max, needed - max);
}

function buildHeaders(sheet) {
  ensureColumns(sheet, lastDataCol());

  // в шапке и в новом блоке не должно быть чужих правил проверки данных
  // (на O1 висел список Take/Stop, из-за него падала запись заголовка)
  sheet.getRange(1, 1, 1, sheet.getMaxColumns()).clearDataValidations();
  sheet.getRange(1, PROP_START_COL, sheet.getMaxRows(), sheet.getMaxColumns() - PROP_START_COL + 1)
    .clearDataValidations();

  sheet.getRange(1, COL_TAKESTOP).setValue('Take/Stop (ист.)');
  sheet.getRange(1, COL_RISK_OLD).setValue('Risk (ист.)');
  sheet.getRange(1, COL_RR_OLD).setValue('RR (ист.)');
  sheet.getRange(1, COL_RESULT).setValue('Скрин закрытия 5м');
  sheet.getRange(1, COL_RESULT_1H).setValue('Скрин закрытия 1ч');
  sheet.getRange(1, COL_GRADE).setValue('Оценка');
  sheet.getRange(1, COL_ACCOUNT_OLD).setValue('Аккаунты');

  var colors = ['#1B5E20', '#0D47A1', '#4A148C', '#B71C1C', '#004D40'];

  for (var i = 0; i < PROPS.length; i++) {
    var c = propCols(i);
    var name = PROPS[i];

    sheet.getRange(1, c.risk, 1, COLS_PER_PROP).setValues([[
      name + ' Risk %',
      name + ' $',
      name + ' %',
      name + ' RR'
    ]]);

    sheet.getRange(1, c.risk, 1, COLS_PER_PROP)
      .setFontWeight('bold')
      .setBackground(colors[i % colors.length])
      .setFontColor('white');
  }

  var total = totalUsdCol();
  sheet.getRange(1, total).setValue('Итого $')
    .setFontWeight('bold').setBackground('#212121').setFontColor('white');

  for (var k = 0; k < PROPS.length; k++) {
    sheet.getRange(1, closeCol(k)).setValue(PROPS[k] + ' закрыто')
      .setFontWeight('normal').setBackground('#EEEEEE').setFontColor('#616161');
  }

  // чистим хвост от прежней схемы (старые колонки U/V и т.п.)
  var last = lastDataCol();
  var tail = sheet.getMaxColumns() - last;
  if (tail > 0) {
    sheet.getRange(1, last + 1, 1, tail).clearContent().setBackground(null);
  }
}

function migrateLegacy(ss, sheet) {
  var lastRow = sheet.getLastRow();
  var result = { migrated: 0, unattributed: [], skipped: [] };
  if (lastRow < 2) return result;

  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    var pair = values[i][3];
    if (isEmpty(pair)) continue;

    var row = i + 1;
    var account = values[i][COL_ACCOUNT_OLD - 1];
    var riskOld = values[i][COL_RISK_OLD - 1];
    var rrOld   = values[i][COL_RR_OLD - 1];
    var date    = values[i][0];

    // уже есть данные в блоке пропов — не трогаем
    var alreadyMigrated = false;
    for (var p = 0; p < PROPS.length; p++) {
      if (!isEmpty(values[i][propCols(p).risk - 1])) alreadyMigrated = true;
    }
    if (alreadyMigrated) continue;

    if (isEmpty(account)) {
      result.unattributed.push({
        row: row,
        date: date instanceof Date ? Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), 'dd.MM.yyyy HH:mm') : String(date),
        pair: String(pair),
        risk: isEmpty(riskOld) ? null : toNumber(riskOld),
        rr: isEmpty(rrOld) ? null : toNumber(rrOld)
      });
      continue;
    }

    var idx = propIndexByName(account);
    if (idx === -1) {
      result.skipped.push({ row: row, account: String(account), reason: 'неизвестный проп' });
      continue;
    }

    var c = propCols(idx);
    var risk = toNumber(riskOld);

    if (risk === null) {
      result.skipped.push({ row: row, account: String(account), reason: 'нет риска' });
      continue;
    }

    sheet.getRange(row, c.risk).setValue(risk);

    if (!isEmpty(rrOld)) {
      var rr = toNumber(rrOld);
      var balance = balanceFor(ss, PROPS[idx], date);

      if (rr !== null && balance) {
        var usd = Math.round(rr * (risk / 100) * balance * 100) / 100;
        sheet.getRange(row, c.usd).setValue(usd);
      }
    }

    result.migrated++;
  }

  return result;
}

function applyAllFormulas(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var n = lastRow - 1;

  for (var i = 0; i < PROPS.length; i++) {
    var c = propCols(i);
    var pctF = [];
    var rrF = [];

    for (var r = 2; r <= lastRow; r++) {
      pctF.push([pctFormula(r, i)]);
      rrF.push([rrFormula(r, i)]);
    }

    sheet.getRange(2, c.pct, n, 1).setFormulas(pctF);
    sheet.getRange(2, c.rr, n, 1).setFormulas(rrF);
  }

  var totalF = [];
  for (var t = 2; t <= lastRow; t++) totalF.push([totalFormula(t)]);
  sheet.getRange(2, totalUsdCol(), n, 1).setFormulas(totalF);

  return n;
}

function formatSheet(sheet) {
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var n = lastRow - 1;

  for (var i = 0; i < PROPS.length; i++) {
    var c = propCols(i);
    sheet.getRange(2, c.risk, n, 1).setNumberFormat('0.0"%"');
    sheet.getRange(2, c.usd,  n, 1).setNumberFormat('#,##0.00" $"');
    sheet.getRange(2, c.pct,  n, 1).setNumberFormat('0.00"%"');
    sheet.getRange(2, c.rr,   n, 1).setNumberFormat('0.00');

    sheet.setColumnWidth(c.risk, 75);
    sheet.setColumnWidth(c.usd, 95);
    sheet.setColumnWidth(c.pct, 75);
    sheet.setColumnWidth(c.rr, 65);
  }

  sheet.getRange(2, totalUsdCol(), n, 1).setNumberFormat('#,##0.00" $"');
  sheet.setColumnWidth(totalUsdCol(), 100);

  sheet.getRange(2, closeCol(0), n, PROPS.length).setNumberFormat('dd.MM.yyyy HH:mm');

  sheet.hideColumns(COL_TAKESTOP, 3);   // O:Q — историческая тройка
  sheet.hideColumns(closeCol(0), PROPS.length);   // моменты закрытия — служебные
  sheet.setFrozenRows(1);
}

/*** Лист статистики ***/

function buildStats(ss, tradesSheet) {
  var name = tradesSheet.getName();
  var sheet = ss.getSheetByName(STATS_SHEET);

  if (sheet) {
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
    sheet.clear();
  } else {
    sheet = ss.insertSheet(STATS_SHEET, 0);
  }

  var months = collectMonths(tradesSheet);
  if (months.length === 0) return 0;

  var colors = ['#1B5E20', '#0D47A1', '#4A148C', '#B71C1C', '#004D40'];

  /* ---- Блок «Сейчас»: текущий баланс и текущий месяц по каждому пропу ---- */

  var nowHead = ['Сейчас', 'Размер аккаунта', 'Баланс зафиксирован', 'Когда', 'P&L после',
    'Текущий баланс', 'Этот месяц $', 'Этот месяц %', 'Сделок в месяце', 'Открыто'];
  sheet.getRange(1, 1, 1, nowHead.length).setValues([nowHead])
    .setFontWeight('bold').setBackground('#212121').setFontColor('white');

  var monthStart = 'DATE(YEAR(TODAY()),MONTH(TODAY()),1)';
  var thisMonth = name + '!$A:$A,">="&' + monthStart + ',' + name + '!$A:$A,"<"&EDATE(' + monthStart + ',1)';
  var P = PROPS_SHEET + '!';
  var B = BALANCES_SHEET + '!';

  // Формула «баланс пропа на момент T» — та же логика, что balanceAt() в getStats:
  // последняя фиксация не позже T + $ сделок, закрытых после неё и не позже T;
  // без фиксаций — размер аккаунта + сделки с даты «Действует с». Момент закрытия —
  // служебная колонка, для старых строк без него — дата открытия (колонка A).
  function balanceAtF(p, T) {
    var c = propCols(p);
    var usd   = name + '!$' + a1col(c.usd) + ':$' + a1col(c.usd);
    var close = name + '!$' + a1col(closeCol(p)) + ':$' + a1col(closeCol(p));
    var open  = name + '!$A:$A';
    var prop  = '"' + PROPS[p].replace(/"/g, '""') + '"';
    var sizeDate = 'MAXIFS(' + P + '$C:$C,' + P + '$A:$A,' + prop + ',' + P + '$C:$C,"<="&' + T + ')';
    var size     = 'SUMIFS(' + P + '$B:$B,' + P + '$A:$A,' + prop + ',' + P + '$C:$C,' + sizeDate + ')';
    var snapAt   = 'MAXIFS(' + B + '$C:$C,' + B + '$A:$A,' + prop + ',' + B + '$C:$C,"<="&' + T + ')';
    var snapBal  = 'SUMIFS(' + B + '$B:$B,' + B + '$A:$A,' + prop + ',' + B + '$C:$C,' + snapAt + ')';

    function closedBetween(op, after) {
      return 'SUMIFS(' + usd + ',' + close + ',"' + op + '"&' + after + ',' + close + ',"<="&' + T + ')' +
        '+SUMIFS(' + usd + ',' + close + ',"",' + open + ',"' + op + '"&' + after + ',' + open + ',"<="&' + T + ')';
    }

    return 'IF(' + snapAt + '=0,' + size + '+' + closedBetween('>=', sizeDate) + ',' +
      snapBal + '+' + closedBetween('>', snapAt) + ')';
  }

  // Текущий баланс — без верхней границы по времени: NOW() в таблице и часы
  // сервера, ставящего момент закрытия, могут разойтись на секунды.
  var farFuture = 'DATE(2999,1,1)';

  for (var s = 0; s < PROPS.length; s++) {
    var sr = 2 + s;
    var sc = propCols(s);
    var sUsd  = name + '!$' + a1col(sc.usd)  + ':$' + a1col(sc.usd);
    var sRisk = name + '!$' + a1col(sc.risk) + ':$' + a1col(sc.risk);
    var propsMatch = P + '$A:$A,$A' + sr;
    var sizeDateNow = 'MAXIFS(' + P + '$C:$C,' + propsMatch + ',' + P + '$C:$C,"<="&TODAY())';
    var snapAtNow   = 'MAXIFS(' + B + '$C:$C,' + B + '$A:$A,$A' + sr + ',' + B + '$C:$C,"<="&NOW())';

    sheet.getRange(sr, 1).setValue(PROPS[s])
      .setFontWeight('bold').setBackground(colors[s % colors.length]).setFontColor('white');
    // B — размер аккаунта (база для %)
    sheet.getRange(sr, 2).setFormula(loc(
      '=IFERROR(SUMIFS(' + P + '$B:$B,' + propsMatch + ',' + P + '$C:$C,' + sizeDateNow + '),"")'));
    // D — момент последней фиксации ("" если фиксаций нет)
    sheet.getRange(sr, 4).setFormula(loc('=IFERROR(IF(' + snapAtNow + '=0,"",' + snapAtNow + '),"")'));
    // C — зафиксированный баланс
    sheet.getRange(sr, 3).setFormula(loc(
      '=IF($D' + sr + '="","",SUMIFS(' + B + '$B:$B,' + B + '$A:$A,$A' + sr + ',' + B + '$C:$C,$D' + sr + '))'));
    // F — текущий баланс
    sheet.getRange(sr, 6).setFormula(loc('=IF($B' + sr + '="","",' + balanceAtF(s, farFuture) + ')'));
    // E — P&L после фиксации (или от размера аккаунта, если фиксаций нет)
    sheet.getRange(sr, 5).setFormula(loc(
      '=IF($F' + sr + '="","",$F' + sr + '-IF($D' + sr + '="",$B' + sr + ',$C' + sr + '))'));
    // G/H — месяц ОТ БАЛАНСА: текущий − баланс на 1-е число; % от размера аккаунта
    sheet.getRange(sr, 7).setFormula(loc(
      '=IF($F' + sr + '="","",$F' + sr + '-' + balanceAtF(s, monthStart) + ')'));
    sheet.getRange(sr, 8).setFormula(loc('=IF($G' + sr + '="","",$G' + sr + '/$B' + sr + '*100)'));
    sheet.getRange(sr, 9).setFormula(loc('=COUNTIFS(' + thisMonth + ',' + sUsd + ',"<>")'));
    sheet.getRange(sr, 10).setFormula(loc('=COUNTIFS(' + sRisk + ',"<>",' + sUsd + ',"")'));
  }

  var nowRows = PROPS.length;
  sheet.getRange(2, 2, nowRows, 1).setNumberFormat('#,##0" $"');
  sheet.getRange(2, 3, nowRows, 1).setNumberFormat('#,##0.00" $"');
  sheet.getRange(2, 4, nowRows, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(2, 5, nowRows, 1).setNumberFormat('+#,##0.00" $";-#,##0.00" $";0" $"');
  sheet.getRange(2, 6, nowRows, 1).setNumberFormat('#,##0.00" $"').setFontWeight('bold');
  sheet.getRange(2, 7, nowRows, 1).setNumberFormat('+#,##0.00" $";-#,##0.00" $";0" $"');
  sheet.getRange(2, 8, nowRows, 1).setNumberFormat('+0.00"%";-0.00"%";0"%"').setFontWeight('bold');
  sheet.getRange(2, 9, nowRows, 2).setNumberFormat('0');

  /* ---- Помесячная таблица ---- */

  var top = nowRows + 3;          // строка первой шапки помесячной таблицы
  var head1 = ['Месяц'];
  var head2 = [''];

  PROPS.forEach(function (prop) {
    head1 = head1.concat([prop, '', '', '', '']);
    head2 = head2.concat(['Сделок', '$', '%', 'Winrate', 'Ср. RR']);
  });

  head1 = head1.concat(['Всего', '', '']);
  head2 = head2.concat(['Сделок', '$', 'Открыто']);

  sheet.getRange(top, 1, 1, head1.length).setValues([head1]);
  sheet.getRange(top + 1, 1, 1, head2.length).setValues([head2]);

  for (var i = 0; i < PROPS.length; i++) {
    var start = 2 + i * 5;
    sheet.getRange(top, start, 1, 5).merge()
      .setHorizontalAlignment('center')
      .setFontWeight('bold')
      .setBackground(colors[i % colors.length])
      .setFontColor('white');
    sheet.getRange(top + 1, start, 1, 5)
      .setFontWeight('bold')
      .setBackground(colors[i % colors.length])
      .setFontColor('white');
  }

  var totalStart = 2 + PROPS.length * 5;
  sheet.getRange(top, totalStart, 1, 3).merge()
    .setHorizontalAlignment('center').setFontWeight('bold')
    .setBackground('#212121').setFontColor('white');
  sheet.getRange(top + 1, totalStart, 1, 3)
    .setFontWeight('bold').setBackground('#212121').setFontColor('white');

  sheet.getRange(top, 1, 2, 1).merge()
    .setFontWeight('bold').setBackground('#212121').setFontColor('white')
    .setVerticalAlignment('middle').setHorizontalAlignment('center');

  // строки по месяцам
  var firstDataRow = top + 2;

  for (var m = 0; m < months.length; m++) {
    var r = firstDataRow + m;
    sheet.getRange(r, 1).setValue(months[m]).setNumberFormat('mmmm yyyy');

    var from = '">="&$A' + r;
    var to = '"<"&EDATE($A' + r + ',1)';
    var dateFilter = name + '!$A:$A,' + from + ',' + name + '!$A:$A,' + to;

    for (var p = 0; p < PROPS.length; p++) {
      var c = propCols(p);
      var usdCol = name + '!$' + a1col(c.usd) + ':$' + a1col(c.usd);
      var rrCol  = name + '!$' + a1col(c.rr)  + ':$' + a1col(c.rr);
      var col = 2 + p * 5;

      // $ — от баланса: баланс на конец месяца (для текущего — сейчас) минус на 1-е число
      var monthEnd = 'EDATE($A' + r + ',1)';
      var endBalance = 'IF(' + monthEnd + '>NOW(),$F$' + (2 + p) + ',' + balanceAtF(p, monthEnd) + ')';
      var usdCell = '$' + a1col(col + 1) + r;

      sheet.getRange(r, col).setFormula(loc(
        '=COUNTIFS(' + dateFilter + ',' + usdCol + ',"<>")'));
      sheet.getRange(r, col + 1).setFormula(loc(
        '=IF($F$' + (2 + p) + '="","",' + endBalance + '-' + balanceAtF(p, '$A' + r) + ')'));
      sheet.getRange(r, col + 2).setFormula(loc(
        '=IF(' + usdCell + '="","",' + usdCell + '/$B$' + (2 + p) + '*100)'));
      sheet.getRange(r, col + 3).setFormula(loc(
        '=IFERROR(COUNTIFS(' + dateFilter + ',' + usdCol + ',">0")' +
        '/COUNTIFS(' + dateFilter + ',' + usdCol + ',"<>"),"")'));
      sheet.getRange(r, col + 4).setFormula(loc(
        '=IFERROR(AVERAGEIFS(' + rrCol + ',' + dateFilter + ',' + usdCol + ',"<>"),"")'));
    }

    var pairCol = name + '!$D:$D';
    // «Всего $» — сумма помесячных $ пропов (те считаются от баланса)
    var allUsd = PROPS.map(function (_, p) {
      return 'N($' + a1col(2 + p * 5 + 1) + r + ')';
    }).join('+');

    var openCount = PROPS.map(function (_, p) {
      var c = propCols(p);
      return 'COUNTIFS(' + dateFilter +
        ',' + name + '!$' + a1col(c.risk) + ':$' + a1col(c.risk) + ',"<>"' +
        ',' + name + '!$' + a1col(c.usd) + ':$' + a1col(c.usd) + ',"")';
    }).join('+');

    sheet.getRange(r, totalStart).setFormula(loc(
      '=COUNTIFS(' + dateFilter + ',' + pairCol + ',"<>")'));
    sheet.getRange(r, totalStart + 1).setFormula(loc('=' + allUsd));
    sheet.getRange(r, totalStart + 2).setFormula(loc('=' + openCount));
  }

  // форматы
  var n = months.length;

  for (var q = 0; q < PROPS.length; q++) {
    var base = 2 + q * 5;
    sheet.getRange(firstDataRow, base + 1, n, 1).setNumberFormat('#,##0.00" $"');
    sheet.getRange(firstDataRow, base + 2, n, 1).setNumberFormat('0.00"%"');
    sheet.getRange(firstDataRow, base + 3, n, 1).setNumberFormat('0%');
    sheet.getRange(firstDataRow, base + 4, n, 1).setNumberFormat('0.00');
  }

  sheet.getRange(firstDataRow, totalStart + 1, n, 1).setNumberFormat('#,##0.00" $"');
  sheet.setColumnWidth(1, 140);
  for (var w = 2; w <= 11; w++) sheet.setColumnWidth(w, 120);
  sheet.setFrozenRows(0);
  sheet.setFrozenColumns(1);

  return n;
}

function collectMonths(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var min = null;

  for (var i = 0; i < values.length; i++) {
    var v = values[i][0];
    if (!(v instanceof Date)) continue;
    if (!min || v < min) min = v;
  }

  if (!min) return [];

  var now = new Date();
  var cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  var end = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  var months = [];

  while (cursor <= end && months.length < 60) {
    months.push(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return months;
}
