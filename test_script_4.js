
require('dotenv').config();
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
fs.writeFileSync('test.txt', 'hello world! '.repeat(100));
const stringSession = new StringSession('');
const client = new TelegramClient(stringSession, 6, 'eb06d4abfb49dc3eeb1aeb98ae0f581e', { connectionRetries: 5 });
(async () => {
    await client.start({ botAuthToken: process.env.BOT_TOKEN });
    console.log('Connected');
    try {
        await client.getDialogs({ limit: 10 });
        const result = await client.sendFile(6305103683, { file: 'test.txt' });
        console.log('Sent success to peer');
    } catch(e) {
        console.log('Error peer:', e.message);
    }
    process.exit(0);
})();

