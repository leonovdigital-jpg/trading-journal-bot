"""Собирает .playwright-mcp/deploy.js: вставляет pine-файл в редактор Pine, обновляет на графике и сохраняет."""
import json, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
js = """async (page) => {
  const code = %s;
  if (!(await page.locator('.monaco-editor .view-lines').count())) {
    await page.locator('[data-name="pine-dialog-button"]').click();
    await page.waitForTimeout(3000);
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: 'https://ru.tradingview.com'});
  await page.evaluate(c => navigator.clipboard.writeText(c), code);
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+V');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Meta+S');
  await page.waitForTimeout(3000);
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(15000);
  const consoleTail = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="consoleRow"], [class*="console"] [class*="message"], [class*="logsList"] span')).map(e => e.innerText).slice(-6));
  await page.screenshot({path: '.playwright-mcp/after-deploy.png', scale: 'css'});
  return {chars: code.length, consoleTail};
}""" % json.dumps(src)
pathlib.Path(".playwright-mcp/deploy.js").write_text(js, encoding="utf-8")
print("ok", len(src))
