-- Открывает календарь FundingPips фоновой вкладкой в Safari пользователя,
-- ждёт, пока он отрисуется, читает его скриптом extract.js и закрывает вкладку.
-- Вкладка открывается в фоне: если человек в этот момент работает, его текущую
-- вкладку не перехватываем.
--
-- Аргумент: путь к extract.js. Печатает JSON, который вернул extract.js.

on run argv
	set jsPath to item 1 of argv
	set js to read (POSIX file jsPath) as «class utf8»
	set theURL to "https://app.fundingpips.com/economic-calendar"
	set madeWindow to false

	tell application "Safari"
		if (count of windows) = 0 then
			make new document with properties {URL:theURL}
			set theWindow to front window
			set theTab to current tab of theWindow
			set madeWindow to true
		else
			set theWindow to front window
			set theTab to make new tab at end of tabs of theWindow with properties {URL:theURL}
		end if
	end tell

	-- Ждём до 40 секунд: пока появятся строки календаря, страница входа,
	-- или защита сайта. Пустой ответ в начале — страница ещё грузится.
	set pageJSON to ""
	set lastErr to ""
	repeat 40 times
		delay 1
		try
			tell application "Safari" to set pageJSON to do JavaScript js in theTab
		on error errMsg
			set pageJSON to ""
			set lastErr to errMsg
		end try
		if pageJSON contains "\"state\":\"ok\"" or pageJSON contains "\"state\":\"logged_out\"" or pageJSON contains "\"state\":\"blocked\"" then exit repeat
	end repeat

	tell application "Safari"
		try
			if madeWindow then
				close theWindow
			else
				close theTab
			end if
		end try
	end tell

	-- Пусто за все 40 секунд — отдаём наружу последнюю ошибку Safari: по ней видно,
	-- не выключено ли «Разрешить JavaScript из Apple Events».
	if pageJSON is "" and lastErr is not "" then error lastErr
	return pageJSON
end run
