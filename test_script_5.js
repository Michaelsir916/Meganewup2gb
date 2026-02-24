
require('dotenv').config();
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');

const stringSession = new StringSession('');
const client = new TelegramClient(stringSession, 6, 'eb06d4abfb49dc3eeb1aeb98ae0f581e', { connectionRetries: 5 });

(async () => {
    await client.start({ botAuthToken: process.env.BOT_TOKEN });
    console.log('Connected! Please send a message to the bot.');

    client.addEventHandler(async (event) => {
        console.log('Received message:', event.message.message);
        try {
            fs.writeFileSync('test.txt', 'hello '.repeat(100));
            await client.sendFile(event.message.chatId, { file: 'test.txt', replyTo: event.message.id });
            console.log('Sent file successfully!');
        } catch(e) {
            console.log('Error replying:', e.message);
        }
        process.exit(0);
    }, new NewMessage({}));
})();

