require('dotenv').config();
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
fs.writeFileSync('test.txt', 'hello world! '.repeat(100));
const stringSession = new StringSession(process.env.SESSION_STRING || '');
const client = new TelegramClient(stringSession, parseInt(process.env.API_ID), process.env.API_HASH, { connectionRetries: 5 });
(async () => {
    await client.start({ botAuthToken: process.env.BOT_TOKEN });
    console.log('Connected');
    try {
        const result = await client.sendFile('michaelsir916', { file: 'test.txt' });
        console.log('Sent success to username');
    } catch (e) {
        console.log('Error username:', e.message);
    }
    process.exit(0);
})();
