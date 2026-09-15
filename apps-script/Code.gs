/*** Trade Journal — Apps Script ***/

var PROPS = ['Instant', '100k challenge', 'FundingPips'];
var PROP_DEFAULT_BALANCE = {
  'Instant': 50000,
  '100k challenge': 100000,
  'FundingPips': 100000
};

var PROP_START_COL = 21;   // U
var COLS_PER_PROP = 4;     // Risk %, $, %, RR

var COL_TAKESTOP   = 15;   // O (устаревшее)
var COL_RISK_OLD   = 16;   // P (устаревшее)
var COL_RR_OLD     = 17;   // Q (устаревшее)
var COL_RESULT     = 18;   // R — скрин результата
var COL_ACCOUNT_OLD = 20;  // T — аккаунт (историческое)

var PROPS_SHEET = 'Props';
var STATS_SHEET = 'Статистика';
var PROPS_MAX_ROW = 50;

/*** Утилиты ***/

function getTradesSheet(ss) {
  return ss.getSheetByName('Traders')
      || ss.getSheetByName('Trades')
      || ss.getSheets()[0];
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
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
    if (data.action === 'updateTrade')   return remember(cache, cacheKey, updateTradeResult(sheet, data));
    if (data.action === 'setup')         return runSetup(ss, sheet);
    if (data.action === 'dump')          return dumpSheet(sheet, data);
    if (data.action === 'ping') {
      return createResponse(true, 'pong', {
        props: PROPS,
        timezone: ss.getSpreadsheetTimeZone(),
        locale: ss.getSpreadsheetLocale(),
        argSep: ARG_SEP,
        maxColumns: sheet.getMaxColumns()
      });
    }
    if (data.action === 'fixDatesOnce')  return fixDatesOnce(ss, sheet);
    if (data.action === 'deleteTestRow') return deleteTestRow(sheet, data);
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
  if (pair.indexOf('TEST-') !== 0) return createResponse(false, 'row ' + row + ' is not a test row: ' + pair);

  sheet.deleteRow(row);
  return createResponse(true, 'deleted', { row: row, pair: pair });
}

function dumpSheet(sheet, data) {
  var values = sheet.getDataRange().getValues();
  var rows = Number(data.rows || 3);
  var out = [];

  for (var i = 0; i < Math.min(values.length, rows + 1); i++) {
    var row = [];
    for (var j = 0; j < values[i].length; j++) {
      var v = values[i][j];
      var type = v instanceof Date ? 'Date' : typeof v;
      row.push(a1col(j + 1) + ':' + type + ':' + String(v).slice(0, 40));
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

function balanceFor(ss, propName, date) {
  var sheet = ss.getSheetByName(PROPS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

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

  return best;
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

  // баланс = последняя строка Props для этого пропа с датой «Действует с» <= даты сделки
  return loc('=IF(' + usd + '="","",IFERROR(' + usd +
    '/LOOKUP(2,ARRAYFORMULA(1/((' + PROPS_SHEET + '!$A$2:$A$' + PROPS_MAX_ROW + '="' + name + '")' +
    '*(' + PROPS_SHEET + '!$C$2:$C$' + PROPS_MAX_ROW + '<=$A' + row + '))),' +
    PROPS_SHEET + '!$B$2:$B$' + PROPS_MAX_ROW + ')*100,""))');
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

  var row = [
    now,
    data.day || '',
    data.session || '',
    data.pair || '',
    data.thoughts || '',
    data.position || '',
    data.errors || '',
    data.rating || '',
    data.screenshot1h || '',
    data.screenshot4h || '',
    data.screenshot1d || '',
    data.dxySmt1 || '',
    data.dxySmt4 || '',
    data.dxySmt1d || ''
  ];

  sheet.appendRow(row);
  var lastRow = sheet.getLastRow();

  sheet.getRange(lastRow, 1).setValue(now).setNumberFormat('dd.MM.yyyy, HH:mm:ss');

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

  if (!isEmpty(data.result)) {
    sheet.getRange(row, COL_RESULT).setValue(data.result);
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
  log.push('Props: ok');

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
  ensureColumns(sheet, totalUsdCol() + 1);

  // в шапке и в новом блоке не должно быть чужих правил проверки данных
  // (на O1 висел список Take/Stop, из-за него падала запись заголовка)
  sheet.getRange(1, 1, 1, sheet.getMaxColumns()).clearDataValidations();
  sheet.getRange(1, PROP_START_COL, sheet.getMaxRows(), sheet.getMaxColumns() - PROP_START_COL + 1)
    .clearDataValidations();

  sheet.getRange(1, COL_TAKESTOP).setValue('Take/Stop (ист.)');
  sheet.getRange(1, COL_RISK_OLD).setValue('Risk (ист.)');
  sheet.getRange(1, COL_RR_OLD).setValue('RR (ист.)');
  sheet.getRange(1, COL_RESULT).setValue('Скрин результата');
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

  // чистим хвост от прежней схемы (старые колонки U/V и т.п.)
  var tail = sheet.getMaxColumns() - total;
  if (tail > 0) {
    sheet.getRange(1, total + 1, 1, tail).clearContent().setBackground(null);
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

  sheet.hideColumns(COL_TAKESTOP, 3);   // O:Q — историческая тройка
  sheet.setFrozenRows(1);
}

/*** Лист статистики ***/

function buildStats(ss, tradesSheet) {
  var name = tradesSheet.getName();
  var sheet = ss.getSheetByName(STATS_SHEET);

  if (sheet) {
    sheet.getRange(1, 1, 2, sheet.getMaxColumns()).breakApart();
    sheet.clear();
  } else {
    sheet = ss.insertSheet(STATS_SHEET, 0);
  }

  var months = collectMonths(tradesSheet);
  if (months.length === 0) return 0;

  // шапка
  var head1 = ['Месяц'];
  var head2 = [''];

  PROPS.forEach(function (prop) {
    head1 = head1.concat([prop, '', '', '', '']);
    head2 = head2.concat(['Сделок', '$', '%', 'Winrate', 'Ср. RR']);
  });

  head1 = head1.concat(['Всего', '', '']);
  head2 = head2.concat(['Сделок', '$', 'Открыто']);

  sheet.getRange(1, 1, 1, head1.length).setValues([head1]);
  sheet.getRange(2, 1, 1, head2.length).setValues([head2]);

  var colors = ['#1B5E20', '#0D47A1', '#4A148C', '#B71C1C', '#004D40'];

  for (var i = 0; i < PROPS.length; i++) {
    var start = 2 + i * 5;
    sheet.getRange(1, start, 1, 5).merge()
      .setHorizontalAlignment('center')
      .setFontWeight('bold')
      .setBackground(colors[i % colors.length])
      .setFontColor('white');
    sheet.getRange(2, start, 1, 5)
      .setFontWeight('bold')
      .setBackground(colors[i % colors.length])
      .setFontColor('white');
  }

  var totalStart = 2 + PROPS.length * 5;
  sheet.getRange(1, totalStart, 1, 3).merge()
    .setHorizontalAlignment('center').setFontWeight('bold')
    .setBackground('#212121').setFontColor('white');
  sheet.getRange(2, totalStart, 1, 3)
    .setFontWeight('bold').setBackground('#212121').setFontColor('white');

  sheet.getRange(1, 1, 2, 1).merge()
    .setFontWeight('bold').setBackground('#212121').setFontColor('white')
    .setVerticalAlignment('middle').setHorizontalAlignment('center');

  // строки по месяцам
  var firstDataRow = 3;

  for (var m = 0; m < months.length; m++) {
    var r = firstDataRow + m;
    sheet.getRange(r, 1).setValue(months[m]).setNumberFormat('mmmm yyyy');

    var from = '">="&$A' + r;
    var to = '"<"&EDATE($A' + r + ',1)';
    var dateFilter = name + '!$A:$A,' + from + ',' + name + '!$A:$A,' + to;

    for (var p = 0; p < PROPS.length; p++) {
      var c = propCols(p);
      var usdCol = name + '!$' + a1col(c.usd) + ':$' + a1col(c.usd);
      var pctCol = name + '!$' + a1col(c.pct) + ':$' + a1col(c.pct);
      var rrCol  = name + '!$' + a1col(c.rr)  + ':$' + a1col(c.rr);
      var col = 2 + p * 5;

      sheet.getRange(r, col).setFormula(loc(
        '=COUNTIFS(' + dateFilter + ',' + usdCol + ',"<>")'));
      sheet.getRange(r, col + 1).setFormula(loc(
        '=SUMIFS(' + usdCol + ',' + dateFilter + ')'));
      sheet.getRange(r, col + 2).setFormula(loc(
        '=SUMIFS(' + pctCol + ',' + dateFilter + ')'));
      sheet.getRange(r, col + 3).setFormula(loc(
        '=IFERROR(COUNTIFS(' + dateFilter + ',' + usdCol + ',">0")' +
        '/COUNTIFS(' + dateFilter + ',' + usdCol + ',"<>"),"")'));
      sheet.getRange(r, col + 4).setFormula(loc(
        '=IFERROR(AVERAGEIFS(' + rrCol + ',' + dateFilter + ',' + usdCol + ',"<>"),"")'));
    }

    var pairCol = name + '!$D:$D';
    var allUsd = PROPS.map(function (_, p) {
      var c = propCols(p);
      return 'SUMIFS(' + name + '!$' + a1col(c.usd) + ':$' + a1col(c.usd) + ',' + dateFilter + ')';
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
  sheet.setColumnWidth(1, 130);
  sheet.setFrozenRows(2);
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
