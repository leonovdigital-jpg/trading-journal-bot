require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyrKuqc4_RwXsu2y_kCZVLbD6BUFMnqyzuokQun-4J13aWQlc96pgME2Ai3vef_oYVhQw/exec';

const userStates = new Map();

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

    const response = await axios.post(WEBHOOK_URL, payload);
    if (!response.data || response.data.success !== true) {
      console.error('Upload rejected by Sheets:', JSON.stringify(response.data).slice(0, 300));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Upload error:', error.message);
    return false;
  }
}

async function updateTradeResult(trade, result, risk, rr) {
  try {
    const takeStop = rr > 0 ? 'Take' : (rr < 0 ? 'Stop' : '');
    const payload = {
      action: 'updateTrade',
      row: trade.row,
      pair: trade.pair,
      result: result,
      risk: risk,
      rr: rr,
      takeStop: takeStop
    };

    const response = await axios.post(WEBHOOK_URL, payload);
    if (!response.data || response.data.success !== true) {
      console.error('Update rejected by Sheets:', JSON.stringify(response.data).slice(0, 300));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Update error:', error.message);
    return false;
  }
}

async function getOpenTrades() {
  const response = await axios.post(WEBHOOK_URL, { action: 'getOpenTrades' });
  const data = response.data;

  if (!data || data.success !== true) {
    throw new Error('Sheets ответил: ' + JSON.stringify(data).slice(0, 200));
  }

  const trades = data.trades || [];
  const today = data.today;

  return {
    today: today,
    todayTrades: trades.filter(t => t.date === today),
    allTrades: trades
  };
}

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  userStates.delete(chatId);
  ctx.reply('👋 Привет! Начинай отправлять Share ссылки с TradingView:\n\n1️⃣ 1h\n2️⃣ 4h\n3️⃣ 1d\n4️⃣ DXY 1h (опционально)\n5️⃣ DXY 4h (опционально)\n6️⃣ DXY 1d (опционально)\n\nКогда закончил → напиши /ready\n\n/closetrade - закрыть сделку');
});

bot.command('closetrade', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId) || {};

  let data;
  try {
    data = await getOpenTrades();
  } catch (error) {
    console.error('Get open trades error:', error.message);
    await ctx.reply('❌ Не могу прочитать журнал: ' + error.message);
    return;
  }

  const useToday = data.todayTrades.length > 0;
  const trades = useToday ? data.todayTrades : data.allTrades;

  if (trades.length === 0) {
    await ctx.reply('❌ В журнале нет незакрытых сделок (все строки уже с RR).');
    return;
  }

  state.openTrades = trades;
  state.step = 'closing_select_trade';
  userStates.set(chatId, state);

  const buttons = trades.map((trade, idx) => [{
    text: useToday
      ? `${trade.pair} · ${trade.session} · ${trade.time}`
      : `${trade.pair} · ${trade.date} ${trade.time}`,
    callback_data: `close_trade_${idx}`
  }]);

  buttons.push([{ text: '❌ Отмена', callback_data: 'close_cancel' }]);

  const header = useToday
    ? `Сделки за сегодня (${data.today}):`
    : `За сегодня сделок нет. Все незакрытые:`;

  await ctx.reply(header + '\n\nКакую закрываем?', {
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
        await ctx.reply('✅ Сделка открыта и записана в журнал!\n\nДля новой отправь ссылки или /closetrade для закрытия');
        state.step = 'idle';
        userStates.set(chatId, state);
      } else {
        await ctx.reply('❌ Не записалось в таблицу. Попробуй ещё раз.');
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
      const trade = (state.openTrades || [])[state.closingTradeIndex];

      if (isNaN(rr)) {
        await ctx.reply('Не понял RR. Введи число, например 1.8 или -0.5');
        return;
      }

      if (!trade) {
        state.step = 'idle';
        userStates.set(chatId, state);
        await ctx.reply('Список сделок потерялся (бот перезапускался). Набери /closetrade заново.');
        return;
      }

      await ctx.reply('⏳ Обновляю результат...');

      const success = await updateTradeResult(trade, state.result, state.risk, rr);

      if (success) {
        await ctx.reply(`✅ Записано: ${trade.pair} · Risk ${state.risk} · RR ${rr}`);
      } else {
        await ctx.reply('❌ Ошибка при обновлении таблицы.');
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

    const trade = (state.openTrades || [])[tradeIdx];
    if (!trade) {
      await ctx.reply('Список устарел. Набери /closetrade заново.');
      await ctx.answerCbQuery();
      return;
    }

    await ctx.reply(`✅ Закрываем: ${trade.pair} (${trade.session})\n📍 Опубликовано: ${trade.date} в ${trade.time}\n\nОтправь скрин результата:`);
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

  try {
    const data = await getOpenTrades();
    console.log(`✅ Sheets ok. Today ${data.today}: ${data.todayTrades.length} open, всего незакрытых ${data.allTrades.length}`);
  } catch (err) {
    console.error('❌ Sheets check failed:', err.message);
  }

  console.log(`📡 Server listening on port ${PORT}`);
});

process.on('SIGINT', () => {
  process.exit(0);
});
