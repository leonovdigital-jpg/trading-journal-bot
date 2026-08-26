const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('@google-cloud/local-auth');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

let authClient = null;

async function authorize() {
  if (authClient) {
    return authClient;
  }

  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const { client_id, client_secret, redirect_uris } = credentials.installed;

      const auth = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );
      auth.setCredentials(token);
      authClient = auth;
      return auth;
    }

    throw new Error('Token not found. Run setup-oauth.js first.');
  } catch (error) {
    console.error('Authorization error:', error);
    throw error;
  }
}

async function uploadScreenshot(filePath, fileName) {
  try {
    const auth = await authorize();
    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name: fileName,
      mimeType: 'image/png'
    };

    const media = {
      mimeType: 'image/png',
      body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    });

    console.log(`Screenshot uploaded: ${fileName} (ID: ${response.data.id})`);

    // Make file public (optional)
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // Return both ID and link
    return {
      id: response.data.id,
      link: response.data.webViewLink
    };
  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
}

module.exports = {
  authorize,
  uploadScreenshot
};
