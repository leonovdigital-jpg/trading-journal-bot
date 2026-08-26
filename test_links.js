const { chromium } = require('playwright');
require('dotenv').config();

async function loginAndGetLinks() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('🔐 Logging in to TradingView...');
    await page.goto('https://www.tradingview.com/', { waitUntil: 'load', timeout: 30000 });
    
    // Find sign in button
    let signInBtn = await page.locator('button').filter({ hasText: 'Sign in' }).first();
    if (signInBtn) {
      await signInBtn.click();
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    }
    
    // Fill email
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.fill(process.env.TRADINGVIEW_EMAIL);
    
    // Fill password
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.fill(process.env.TRADINGVIEW_PASSWORD);
    
    // Click login
    const loginBtn = page.locator('button').filter({ hasText: 'Sign in' }).last();
    await loginBtn.click();
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    
    await new Promise(r => setTimeout(r, 2000));
    console.log('✅ Logged in\n');
    
    // Now get links
    const results = {};
    for (const [name, tf] of Object.entries({'1h': '60', '4h': '240', '1d': '1440'})) {
      console.log(`⏳ UK100 ${name}...`);
      
      const url = `https://www.tradingview.com/chart/${tf}UK100/`;
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      
      try {
        // Find share button - try different selectors
        let shareBtn = null;
        try {
          shareBtn = page.locator('button:has-text("Share")').first();
          await shareBtn.click({ timeout: 5000 });
        } catch (e1) {
          try {
            shareBtn = page.locator('button[title="Share"]').first();
            await shareBtn.click({ timeout: 5000 });
          } catch (e2) {
            throw new Error('Share button not found');
          }
        }
        
        await new Promise(r => setTimeout(r, 1500));
        
        const linkInput = page.locator('input[readonly]').first();
        const link = await linkInput.inputValue({ timeout: 5000 });
        
        console.log(`✅ ${link}\n`);
        results[name] = link;
      } catch (e) {
        console.log(`❌ Failed: ${e.message.substring(0, 50)}\n`);
        results[name] = null;
      }
    }
    
    console.log('📊 RESULTS:\n');
    Object.entries(results).forEach(([tf, link]) => {
      console.log(`${tf}: ${link || 'FAILED'}`);
    });
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    await browser.close();
  }
}

loginAndGetLinks();
