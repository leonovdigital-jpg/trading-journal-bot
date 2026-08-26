const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('@google-cloud/local-auth');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

let authClient = null;

async function authorize() {
  if (authClient) {
    return authClient;
  }

  try {
    // Try to load existing token
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      auth.setCredentials(token);
      authClient = auth;
      return auth;
    }

    // Create new OAuth flow if credentials exist
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const { client_id, client_secret, redirect_uris } = credentials.installed;

      const auth = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );

      authClient = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH
      });

      return authClient;
    }

    throw new Error('No credentials found. Please set up OAuth credentials.');
  } catch (error) {
    console.error('Authorization error:', error);
    throw error;
  }
}

async function appendToSheet(spreadsheetId, values) {
  try {
    const auth = await authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    const request = {
      spreadsheetId,
      range: 'Лист1!A:O', // Columns up to O (Date, Day, Session, Pair, Thoughts, etc.)
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [values]
      }
    };

    const response = await sheets.spreadsheets.values.append(request);
    console.log('Data appended to sheet:', response.data);
    return response.data;
  } catch (error) {
    console.error('Sheet append error:', error);
    throw error;
  }
}

async function createSheet(spreadsheetId, title) {
  try {
    const auth = await authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    const request = {
      spreadsheetId,
      resource: {
        requests: [
          {
            addSheet: {
              properties: {
                title,
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 15
                }
              }
            }
          }
        ]
      }
    };

    const response = await sheets.spreadsheets.batchUpdate(request);
    console.log('Sheet created:', response.data);
    return response.data;
  } catch (error) {
    console.error('Sheet creation error:', error);
    throw error;
  }
}

module.exports = {
  authorize,
  appendToSheet,
  createSheet
};
