const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function setupOAuth() {
  console.log('\n🔐 Google OAuth Setup\n');

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ credentials.json не найден!');
    console.log('\n📋 Инструкции:');
    console.log('1. Иди на https://console.cloud.google.com/');
    console.log('2. Создай новый проект (или выбери существующий)');
    console.log('3. Enable Google Sheets API');
    console.log('4. Create OAuth 2.0 Desktop Application credentials');
    console.log('5. Скачай JSON файл и сохрани его как credentials.json в корне проекта');
    console.log('6. Запусти этот скрипт снова\n');
    rl.close();
    return;
  }

  try {
    const credentialsData = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_id, client_secret, redirect_uris } = credentialsData.installed;

    const auth = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    const authUrl = auth.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });

    console.log('\n🔗 Открой эту ссылку в браузере:\n');
    console.log(authUrl);
    console.log('\n');

    const code = await question('Вставь полученный код авторизации: ');

    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // Save token
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('\n✅ Token сохранён! Бот готов к работе.\n');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  } finally {
    rl.close();
  }
}

setupOAuth();
