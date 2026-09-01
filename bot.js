require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyrKuqc4_RwXsu2y_kCZVLbD6BUFMnqyzuokQun-4J13aWQlc96pgME2Ai3vef_oYVhQw/exec';

const userStates = new Map();
let globalOpenTrades = [];

async function initializeOpenTrades() {
  try {
    const response = await axios.post(WEBHOOK_URL, { action: 'getOpenTrades' });
    globalOpenTrades = response.data.trades || [];
    console.log(`✅ Loaded ${globalOpenTrades.length} open trades`);
  } catch (error) {
    console.error('Failed to initialize open trades:', error.message);
    globalOpenTrades = [];
  }
}

async function uploadToGoogleSheets(data, links) {
  try {
    const payload = {
      dateTime: data.dateTime,
      day: data.day,
      session: data.session,
      pair: data.pair,
      thoughts: data.thoughts,
      position: data.position,
      errors: '',
      rating: links[0] || '',
      screenshot1h: links[1] || '',
      screenshot4h: links[2] || '',
      screenshot1d: links[3] || '',
      dxySmt1: links[4] || '',
      dxySmt4: links[5] || '',
      dxySmt1d: links[6] || ''
    };

    await axios.post(WEBHOOK_URL, payload);
    return true;
  } catch (error) {
    console.error('Upload error:', error.message);
    return false;
  }
}

async function updateTradeResult(pair, result, risk, rr) {
  try {
    const takeStop = rr > 0 ? 'Take' : (rr < 0 ? 'Stop' : '');
    const payload = {
      action: 'updateTrade',
      pair: pair,
      result: result,
      risk: risk,
      rr: rr,
      takeStop: takeStop
    };

    await axios.post(WEBHOOK_URL, payload);
    return true;
  } catch (error) {
    console.error('Update error:', error.message);
    return false;
  }
}

async function getOpenTrades() {
  try {
    const response = await axios.get(WEBHOOK_URL + '?action=getOpenTrades');
    return response.data.trades || [];
  } catch (error) {
    console.error('Get open trades error:', error.message);
    return [];
  }
}

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  userStates.delete(chatId);
  ctx.reply('👋 Привет! Начинай отправлять Share ссылки с TradingView:\n\n1️⃣ 1h\n2️⃣ 4h\n3️⃣ 1d\n4️⃣ DXY 1h (опционально)\n5️⃣ DXY 4h (опционально)\n6️⃣ DXY 1d (опционально)\n\nКогда закончил → напиши /ready\n\n/closetrade - закрыть сделку');
});

bot.command('closetrade', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId) || {};

  if (!globalOpenTrades || globalOpenTrades.length === 0) {
    await ctx.reply('❌ Нет открытых сделок');
    return;
  }

  state.openTrades = globalOpenTrades;
  state.step = 'closing_select_trade';
  userStates.set(chatId, state);

  const buttons = globalOpenTrades.map((trade, idx) => [
    { text: `${trade.pair} (${trade.session})`, callback_data: `close_trade_${idx}` }
  ]);

  buttons.push([{ text: '❌ Отмена', callback_data: 'close_cancel' }]);

  await ctx.reply('Какую сделку закрываем?', {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const state = userStates.get(chatId) || {};

    const links = text.match(/https:\/\/(?:[a-z]*\.)?tradingview\.com\/x\/[a-zA-Z0-9]+/g) || [];

    if (links.length > 0 && (!state.step || state.step === 'collecting_links')) {
      state.links = links;
      state.step = 'links_ready';
      userStates.set(chatId, state);

      const tfNames = ['1-5', '1h', '4h', '1d', 'DXY 1h', 'DXY 4h', 'DXY 1d'];
      const display = links.map((_, i) => `${i+1}. ${tfNames[i] || `Link ${i+1}`}`).join('\n');

      await ctx.reply(`✅ Получено ${links.length} ссылок:\n\n${display}\n\nДалее → выбери актив`);

      state.step = 'waiting_asset';
      userStates.set(chatId, state);

      await ctx.reply('Какой актив?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'USDCHF', callback_data: 'asset_USDCHF' }],
            [{ text: 'UK100', callback_data: 'asset_UK100' }],
            [{ text: 'US30', callback_data: 'asset_US30' }]
          ]
        }
      });
      return;
    }

    if (state.step === 'waiting_thoughts') {
      state.thoughts = text;
      await ctx.reply('⏳ Загружаю в журнал...');

      const sheetData = {
        dateTime: new Date().toLocaleString('ru-RU'),
        day: new Date().toLocaleDateString('ru-RU', { weekday: 'long' }),
        session: state.session,
        pair: state.asset,
        thoughts: state.thoughts,
        position: state.position
      };

      const success = await uploadToGoogleSheets(sheetData, state.links);

      if (success) {
        globalOpenTrades.push({
          pair: state.asset,
          session: state.session,
          dateTime: sheetData.dateTime
        });

        await ctx.reply('✅ Сделка открыта!\n\nДля новой отправь ссылки или /closetrade для закрытия');
        state.step = 'idle';
        userStates.set(chatId, state);
      } else {
        await ctx.reply('❌ Ошибка. Попробуй ещё раз.');
      }
    } else if (state.step === 'closing_result') {
      state.result = text;
      state.step = 'closing_risk';
      userStates.set(chatId, state);

      await ctx.reply('Какой Risk?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '0.5', callback_data: 'risk_0.5' }],
            [{ text: '1', callback_data: 'risk_1' }],
            [{ text: 'Своё', callback_data: 'risk_custom' }]
          ]
        }
      });
    } else if (state.step === 'closing_risk_custom') {
      state.risk = parseFloat(text);
      state.step = 'closing_rr';
      userStates.set(chatId, state);

      await ctx.reply('Какой RR?');
    } else if (state.step === 'closing_rr') {
      const rr = parseFloat(text);
      const tradeIdx = state.closingTradeIndex;
      const trade = state.openTrades[tradeIdx];

      await ctx.reply('⏳ Обновляю результат...');

      const success = await updateTradeResult(trade.pair, state.result, state.risk, rr);

      if (success) {
        globalOpenTrades.splice(tradeIdx, 1);
        await ctx.reply('✅ Результат записан!');
      } else {
        await ctx.reply('❌ Ошибка при обновлении.');
      }

      state.step = 'idle';
      userStates.set(chatId, state);
    }
  } catch (err) {
    console.error('❌ Error in text handler:', err.message, err.stack);
  }
});

bot.on('callback_query', async (ctx) => {
  const chatId = ctx.chat.id;
  const data = ctx.callbackQuery.data;
  const state = userStates.get(chatId) || {};

  if (data.startsWith('asset_')) {
    state.asset = data.replace('asset_', '');
    state.step = 'waiting_session';
    userStates.set(chatId, state);

    await ctx.reply('Какая сессия?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'LO', callback_data: 'session_LO' }],
          [{ text: 'NY', callback_data: 'session_NY' }],
          [{ text: 'NYSE', callback_data: 'session_NYSE' }]
        ]
      }
    });
  } else if (data.startsWith('session_')) {
    state.session = data.replace('session_', '');
    state.step = 'waiting_position';
    userStates.set(chatId, state);

    await ctx.reply('Long или Short?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Long', callback_data: 'pos_Long' }],
          [{ text: 'Short', callback_data: 'pos_Short' }]
        ]
      }
    });
  } else if (data.startsWith('pos_')) {
    state.position = data.replace('pos_', '');
    state.step = 'waiting_thoughts';
    userStates.set(chatId, state);

    await ctx.reply('Напиши свои мысли перед входом:');
  } else if (data.startsWith('close_trade_')) {
    const tradeIdx = parseInt(data.split('_')[2]);
    state.closingTradeIndex = tradeIdx;
    state.step = 'closing_result';
    userStates.set(chatId, state);

    const trade = state.openTrades[tradeIdx];
    await ctx.reply(`✅ Закрываем: ${trade.pair}\n\nОтправь скрин результата:`);
  } else if (data.startsWith('risk_')) {
    if (data === 'risk_custom') {
      state.step = 'closing_risk_custom';
      userStates.set(chatId, state);
      await ctx.reply('Введи Risk:');
    } else {
      state.risk = parseFloat(data.split('_')[1]);
      state.step = 'closing_rr';
      userStates.set(chatId, state);
      await ctx.reply('Введи RR:');
    }
  } else if (data === 'close_cancel') {
    state.step = 'idle';
    userStates.set(chatId, state);
    await ctx.reply('❌ Отменено');
  }

  await ctx.answerCbQuery();
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/bot', (req, res) => {
  console.log('📨 Incoming update:', JSON.stringify(req.body, null, 2));
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  const BOT_DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://trading-journal-bot.onrender.com';
  const webhookUrl = `${BOT_DOMAIN}/bot`;

  try {
    await bot.telegram.deleteWebhook();
    console.log('🗑️ Deleted old webhook');

    await new Promise(r => setTimeout(r, 1000));

    await bot.telegram.setWebhook(webhookUrl);
    console.log(`🤖 Trade Journal Bot webhook set to ${webhookUrl}`);

    const info = await bot.telegram.getWebhookInfo();
    console.log(`📍 Webhook info:`, JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }

  await initializeOpenTrades();
  console.log(`📡 Server listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  process.exit(0);
});
