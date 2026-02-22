const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// GramJS Client Setup
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION_STRING || '');

let telegramClient = null;

if (apiId && apiHash) {
    telegramClient = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
}

let botUsername = '';
function cleanMegaLink(link) {
    if (!link) return null;
    let cleanedLink = link.trim()
        .replace(/\s+/g, '')
        .replace(/[\<\>]/g, '');
    if (cleanedLink.includes('mega.nz')) {
        // Ensure it starts with https://
        if (!cleanedLink.startsWith('http')) {
            cleanedLink = 'https://' + cleanedLink;
        }
        return cleanedLink;
    }
    return null;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function isVideoFile(filename) {
    const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv'];
    const ext = path.extname(filename).toLowerCase();
    return videoExtensions.includes(ext);
}

function isImageFile(filename) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg', '.ico'];
    const ext = path.extname(filename).toLowerCase();
    return imageExtensions.includes(ext);
}

function isAudioFile(filename) {
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus'];
    const ext = path.extname(filename).toLowerCase();
    return audioExtensions.includes(ext);
}

async function sendTelegramFile(ctx, filePath, fileName, fileSize, progressMsg) {
    const captionText = `${fileName}\nSize: ${formatBytes(fileSize)}`;

    try {
        if (!telegramClient || !telegramClient.connected) {
            throw new Error("MTProto client not connected. Falling back to simple upload...");
        }

        let lastUpdate = 0;

        const progressCallback = async (progress) => {
            const now = Date.now();
            // Throttle progress updates to every 2 seconds to avoid Telegram rate limits
            if (now - lastUpdate > 2000 || progress === 1 || progress === 0) {
                lastUpdate = now;
                const percent = Math.round(progress * 100);

                // Create a visual progress bar
                const barLength = 10;
                const filledLength = Math.round(barLength * progress);
                const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

                try {
                    if (progressMsg) {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            progressMsg.message_id,
                            null,
                            `📤 *Uploading to Telegram*\n\n[${bar}] ${percent}%\n*File:* \`${fileName}\``,
                            { parse_mode: 'Markdown' }
                        );
                    }
                } catch (e) {
                    // Ignore message not modified errors
                }
            }
        };

        // Determine GramJS attributes based on file type
        let attributes = [];
        const { Api } = require('telegram');

        if (isVideoFile(fileName)) {
            attributes.push(new Api.DocumentAttributeVideo({
                w: 1280,
                h: 720,
                duration: 0,
                supportsStreaming: true,
            }));
        } else if (isAudioFile(fileName)) {
            attributes.push(new Api.DocumentAttributeAudio({
                duration: 0,
                title: path.basename(fileName, path.extname(fileName)),
                performer: "MEGA Downloader"
            }));
        }

        await telegramClient.sendFile(ctx.chat.id, {
            file: filePath,
            caption: captionText,
            progressCallback: progressCallback,
            workers: 4, // Maximize upload speed
            attributes: attributes.length > 0 ? attributes : undefined
        });

    } catch (error) {
        console.error(`GramJS upload failed, using fallback: ${error.message}`);

        // Fallback to standard telegraf send for simple/small files
        const fileOptions = { source: filePath, filename: fileName };
        try {
            if (isVideoFile(fileName)) {
                return await ctx.replyWithVideo(fileOptions, { caption: `🎬 ${captionText}`, supports_streaming: true });
            } else if (isImageFile(fileName)) {
                return await ctx.replyWithPhoto(fileOptions, { caption: `🖼️ ${captionText}` });
            } else if (isAudioFile(fileName)) {
                return await ctx.replyWithAudio(fileOptions, { caption: `🎵 ${captionText}`, title: path.basename(fileName, path.extname(fileName)) });
            } else {
                return await ctx.replyWithDocument(fileOptions, { caption: `📄 ${captionText}` });
            }
        } catch (fbError) {
            console.error(`Fallback failed: ${fbError.message}`);
            return await ctx.replyWithDocument(fileOptions, { caption: `📁 ${captionText}` });
        }
    }
}

function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

function cleanupFolder(folderPath) {
    try {
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Folder cleanup error:', error);
    }
}

async function getAllFilesFromFolder(folder) {
    const files = [];

    try {
        if (folder.children && Array.isArray(folder.children)) {
            for (const child of folder.children) {
                if (child.directory) {
                    const subfolderFiles = await getAllFilesFromFolder(child);
                    files.push(...subfolderFiles);
                } else {
                    files.push(child);
                }
            }
        } else {
            await new Promise((resolve, reject) => {
                if (typeof folder.loadChildren === 'function') {
                    folder.loadChildren((err, children) => {
                        if (err) reject(err);
                        else {
                            folder.children = children;
                            resolve();
                        }
                    });
                } else if (typeof folder.getChildren === 'function') {
                    folder.getChildren((err, children) => {
                        if (err) reject(err);
                        else {
                            folder.children = children;
                            resolve();
                        }
                    });
                } else {
                    reject(new Error('Cannot load folder contents'));
                }
            });

            for (const child of folder.children) {
                if (child.directory) {
                    const subfolderFiles = await getAllFilesFromFolder(child);
                    files.push(...subfolderFiles);
                } else {
                    files.push(child);
                }
            }
        }
    } catch (error) {
        console.error('Error getting folder contents:', error);
        throw error;
    }

    return files;
}
async function downloadMegaFolder(folder, tempDir) {
    console.log(`📁 Folder detected: ${folder.name}`);

    try {
        const allFiles = await getAllFilesFromFolder(folder);

        if (allFiles.length === 0) {
            throw new Error('Folder is empty');
        }

        console.log(`📊 Found ${allFiles.length} files in folder`);

        const folderDir = path.join(tempDir, folder.name);
        if (!fs.existsSync(folderDir)) {
            fs.mkdirSync(folderDir, { recursive: true });
        }

        const downloadedFiles = [];
        const downloadErrors = [];

        for (let i = 0; i < allFiles.length; i++) {
            const file = allFiles[i];

            try {
                console.log(`⬇️  Downloading [${i + 1}/${allFiles.length}]: ${file.name}`);

                const filePath = path.join(folderDir, file.name);
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) {
                    fs.mkdirSync(fileDir, { recursive: true });
                }

                await new Promise((resolve, reject) => {
                    const writeStream = fs.createWriteStream(filePath);

                    file.download()
                        .on('error', (err) => {
                            writeStream.end();
                            cleanupFile(filePath);
                            reject(err);
                        })
                        .pipe(writeStream);

                    writeStream.on('finish', () => {
                        downloadedFiles.push({
                            path: filePath,
                            name: file.name,
                            size: file.size
                        });
                        resolve();
                    });

                    writeStream.on('error', (err) => {
                        cleanupFile(filePath);
                        reject(err);
                    });
                });

            } catch (error) {
                console.error(`❌ Failed to download ${file.name}:`, error.message);
                downloadErrors.push(`${file.name}: ${error.message}`);
            }
        }

        if (downloadedFiles.length === 0) {
            throw new Error('All downloads failed');
        }

        const totalSize = downloadedFiles.reduce((sum, file) => sum + file.size, 0);

        return {
            type: 'folder',
            folderPath: folderDir,
            files: downloadedFiles,
            fileCount: downloadedFiles.length,
            totalSize: totalSize,
            errors: downloadErrors
        };

    } catch (error) {
        throw new Error(`Folder download failed: ${error.message}`);
    }
}

async function downloadMegaFile(megaUrl, userId) {
    console.log(`🔗 Processing URL: ${megaUrl}`);

    const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        try {
            const file = mega.File.fromURL(megaUrl);

            if (!file) {
                throw new Error('Could not parse MEGA URL');
            }

            file.loadAttributes((err) => {
                if (err) {
                    console.error('❌ Error loading attributes:', err.message);

                    let errorMsg = `Failed to load: ${err.message}`;

                    if (err.message.includes('ENOENT') || err.message.includes('not found')) {
                        errorMsg = 'File/Folder not found. Link may be expired or invalid.';
                    } else if (err.message.includes('decryption')) {
                        errorMsg = 'Decryption failed. Check if your link has the correct key';
                    }

                    reject(new Error(errorMsg));
                    return;
                }

                console.log(`✅ File loaded: ${file.name} (${formatBytes(file.size)})`);

                if (file.directory) {
                    console.log('📁 This is a folder');

                    downloadMegaFolder(file, tempDir)
                        .then(resolve)
                        .catch(reject);

                } else {
                    console.log('📄 This is a file');

                    const tempPath = path.join(tempDir, file.name);

                    console.log(`⬇️  Starting download to: ${tempPath}`);

                    const writeStream = fs.createWriteStream(tempPath);

                    file.download()
                        .on('error', (err) => {
                            console.error('❌ Download error:', err.message);
                            writeStream.end();
                            cleanupFile(tempPath);
                            reject(new Error(`Download failed: ${err.message}`));
                        })
                        .pipe(writeStream);

                    writeStream.on('finish', () => {
                        console.log('💾 File saved successfully');
                        resolve({
                            type: 'file',
                            path: tempPath,
                            name: file.name,
                            size: file.size
                        });
                    });

                    writeStream.on('error', (err) => {
                        console.error('❌ Write error:', err.message);
                        cleanupFile(tempPath);
                        reject(new Error(`Failed to save file: ${err.message}`));
                    });
                }
            });

        } catch (error) {
            console.error('❌ Error creating MEGA object:', error.message);
            reject(new Error(`Invalid MEGA link: ${error.message}`));
        }
    });
}

async function processMegaLink(ctx, megaLink) {
    const userId = ctx.from ? ctx.from.id : ctx.chat.id;
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;

    console.log(`📩 Processing MEGA link in ${chatType} ${chatId} from user ${userId}`);

    try {
        let statusMsg;
        try {
            statusMsg = await ctx.reply(`🔍 *Processing MEGA Link*\n\nChecking link...`, {
                parse_mode: 'Markdown'
            });
        } catch (statusError) {
            console.error('Cannot send status message:', statusError.message);

            try {
                statusMsg = await ctx.reply(`🔍 Processing MEGA Link\n\nChecking link...`);
            } catch (e) {
                console.error('Cannot send simple status either:', e.message);
            }
        }

        const result = await downloadMegaFile(megaLink, userId);

        const editStatus = async (text) => {
            if (statusMsg) {
                try {
                    await ctx.telegram.editMessageText(
                        chatId,
                        statusMsg.message_id,
                        null,
                        text,
                        { parse_mode: 'Markdown' }
                    );
                } catch (editError) {
                    try {
                        await ctx.telegram.editMessageText(
                            chatId,
                            statusMsg.message_id,
                            null,
                            text.replace(/\*/g, '').replace(/_/g, '').replace(/`/g, '')
                        );
                    } catch (e) {
                        console.error('Cannot edit status:', e.message);
                    }
                }
            }
        };

        const deleteStatus = async () => {
            if (statusMsg) {
                try {
                    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);
                } catch (deleteError) {
                    console.error('Cannot delete status:', deleteError.message);
                }
            }
        };

        if (result.type === 'file') {
            await editStatus(`✅ *File Loaded*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n📤 Sending to Telegram...`);

            const maxFileSize = 2 * 1024 * 1024 * 1024;
            if (result.size > maxFileSize) {
                await editStatus(`❌ *File Too Large*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n⚠️ Telegram limit is 2GB per file.`);
                cleanupFile(result.path);
                return;
            }

            try {
                // Pass statusMsg to sendTelegramFile to be used as the progress message
                await sendTelegramFile(ctx, result.path, result.name, result.size, statusMsg);
                await deleteStatus();

                if (chatType !== 'private') {
                    try {
                        await ctx.reply(`✅ *File sent successfully!*`);
                    } catch (e) {
                        console.error('Cannot send success message:', e.message);
                    }
                }
            } catch (sendError) {
                await editStatus(`❌ *Failed to Send*\n\n*File:* \`${result.name}\`\n*Error:* ${sendError.message}`);
            }

            cleanupFile(result.path);

        } else if (result.type === 'folder') {
            await editStatus(`📦 *Folder Ready*\n\n*Name:* \`${path.basename(result.folderPath)}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}\n\n📤 Starting to send files...`);

            await deleteStatus();

            try {
                await ctx.reply(`📁 *Folder Download Complete*\n\n*Name:* \`${path.basename(result.folderPath)}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}`, {
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                console.error('Cannot send folder info:', e.message);
            }

            let sentCount = 0;
            let failedCount = 0;
            const maxFileSize = 2 * 1024 * 1024 * 1024;

            let progressMsg;
            try {
                progressMsg = await ctx.reply(`📤 *Sending Files*\n\n✅ Sent: 0/${result.fileCount}\n❌ Failed: 0`, {
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                console.error('Cannot send progress message:', e.message);
            }

            const updateProgress = async () => {
                if (progressMsg) {
                    try {
                        await ctx.telegram.editMessageText(
                            chatId,
                            progressMsg.message_id,
                            null,
                            `📤 *Sending Files*\n\n✅ Sent: ${sentCount}/${result.fileCount}\n❌ Failed: ${failedCount}`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (e) {
                        console.error('Cannot update progress:', e.message);
                    }
                }
            };

            for (const file of result.files) {
                try {
                    if (file.size > maxFileSize) {
                        failedCount++;
                        continue;
                    }

                    await updateProgress();

                    await sendTelegramFile(ctx, file.path, file.name, file.size, progressMsg);

                    sentCount++;

                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (fileError) {
                    console.error(`Failed to send ${file.name}:`, fileError.message);
                    failedCount++;
                }
            }

            if (progressMsg) {
                try {
                    await ctx.telegram.deleteMessage(chatId, progressMsg.message_id);
                } catch (e) {
                    console.error('Cannot delete progress message:', e.message);
                }
            }

            cleanupFolder(result.folderPath);

            let summary = `✅ *Folder Transfer Complete!*\n\n`;
            summary += `📁 *Folder:* \`${path.basename(result.folderPath)}\`\n`;
            summary += `📊 *Total Files:* ${result.fileCount}\n`;
            summary += `✅ *Sent Successfully:* ${sentCount}\n`;

            if (failedCount > 0) {
                summary += `❌ *Failed/Skipped:* ${failedCount} (files >2GB)\n`;
            }

            summary += `💾 *Total Size:* ${formatBytes(result.totalSize)}`;

            try {
                await ctx.reply(summary, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error('Cannot send summary:', e.message);
            }

            // Cleanup temp directory
            const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
            cleanupFolder(tempDir);
        }

    } catch (error) {
        console.error('❌ Main error:', error.message);

        let errorMessage = `❌ *Download Failed*\n\n`;
        errorMessage += `*Error:* ${error.message}\n\n`;
        errorMessage += `*Please check:*\n`;
        errorMessage += `1. Link is correct and not expired\n`;
        errorMessage += `2. Includes #key at the end\n`;
        errorMessage += `3. File/folder exists`;

        try {
            await ctx.reply(errorMessage, { parse_mode: 'Markdown' });
        } catch (sendError) {
            console.error('Cannot send error message:', sendError.message);
        }

        const tempDir = path.join(os.tmpdir(), 'mega-bot', userId.toString());
        cleanupFolder(tempDir);
    }
}

bot.start((ctx) => {
    const chatType = ctx.chat.type;
    const chatName = chatType === 'private' ? 'here' : `in this ${chatType}`;

    ctx.reply(`🤖 *MEGA Downloader Bot*

*I can download MEGA files and folders ${chatName}!*

Just send me any MEGA link and I'll download it.

*Features:*
• Works in private chats, groups, and channels
• Downloads files and folders
• Auto-detects file types
• Shows progress
• Automatic cleanup

*Supported Formats:*
• \`https://mega.nz/file/ID#KEY\`
• \`https://mega.nz/folder/ID#KEY\`

*For Groups/Channels:*
1. Add me as admin
2. Give me permission to read messages
3. Send MEGA link in chat
4. I'll download and send files directly

Send me a MEGA link to get started!`, {
        parse_mode: 'Markdown'
    });
});

bot.help((ctx) => {
    const chatType = ctx.chat.type;

    if (chatType === 'private') {
        ctx.reply(`📖 *Help - Private Chat*

Just send me any MEGA link and I'll download it for you!

*Valid link formats:*
✅ \`https://mega.nz/file/ABC123#XYZ456\`
✅ \`https://mega.nz/folder/DEF789#UVW012\`

*Requirements:*
• Link must include #key at the end
• File size must be under 2GB for Telegram`, {
            parse_mode: 'Markdown'
        });
    } else {
        ctx.reply(`📖 *Help - ${chatType === 'group' ? 'Group' : 'Channel'}*

I can download MEGA files here too!

*IMPORTANT: For me to work in this ${chatType}:*
1. I must be added as admin
2. I need permission to read messages
3. I need permission to send messages/media

*How to use:*
Just send any MEGA link in chat, I'll process it automatically.

*Link formats:*
• \`https://mega.nz/file/ID#KEY\`
• \`https://mega.nz/folder/ID#KEY\``, {
            parse_mode: 'Markdown'
        });
    }
});

bot.on('message', async (ctx) => {
    const text = ctx.message.text;

    if (!text) return;

    const megaLink = cleanMegaLink(text);

    if (!megaLink) {
        if (ctx.chat.type !== 'private') {
            const botUsername = ctx.botInfo?.username;
            if (botUsername && text.includes(`@${botUsername}`)) {
                await ctx.reply(`🤖 Hi! Send me a MEGA link to download files.\n\nExample: \`https://mega.nz/file/ABC123#XYZ456\``, {
                    parse_mode: 'Markdown'
                });
            }
        }
        return;
    }

    console.log(`🔍 Detected MEGA link in ${ctx.chat.type} ${ctx.chat.id}`);

    if (ctx.chat.type !== 'private') {
        try {
            const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);

            if (ctx.chat.type === 'channel') {
                if (chatMember.status !== 'administrator') {
                    console.log(`❌ Bot is not admin in channel ${ctx.chat.id}`);

                    if (ctx.from) {
                        try {
                            await ctx.telegram.sendMessage(
                                ctx.from.id,
                                `❌ I cannot process MEGA links in this channel because I'm not an admin.\n\nPlease make me an admin with permission to read and post messages.`
                            );
                        } catch (e) {
                            console.error('Cannot send private message:', e.message);
                        }
                    }
                    return;
                }

                if (!chatMember.can_post_messages) {
                    console.log(`❌ Bot cannot post messages in channel ${ctx.chat.id}`);
                    return;
                }
            }

            if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                if (chatMember.status === 'restricted') {
                    // Check if bot can send messages
                    if (!chatMember.can_send_messages) {
                        console.log(`❌ Bot cannot send messages in group ${ctx.chat.id}`);
                        return;
                    }
                } else if (chatMember.status !== 'administrator' && chatMember.status !== 'member') {
                    console.log(`❌ Bot doesn't have proper status in group ${ctx.chat.id}: ${chatMember.status}`);
                    return;
                }
            }

        } catch (error) {
            console.error(`❌ Error checking permissions in ${ctx.chat.type} ${ctx.chat.id}:`, error.message);
            return;
        }
    }

    await processMegaLink(ctx, megaLink);
});

bot.on('document', (ctx) => {
    if (ctx.chat.type === 'private') {
        ctx.reply('📎 Send me a MEGA link to download files!\n\nExample:\n\`https://mega.nz/file/ABC123#XYZ456\`', {
            parse_mode: 'Markdown'
        });
    }
});

bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    try {
        if (ctx.chat.type === 'private') {
            ctx.reply('❌ An internal error occurred. Please try again.');
        }
    } catch (e) {
        console.error('Failed to send error:', e);
    }
});

bot.telegram.getMe().then(async botInfo => {
    botUsername = botInfo.username;
    console.log(`🤖 Bot username: @${botUsername}`);

    console.log('🚀 Starting MEGA Downloader Bot...');
    console.log('👥 Working in: Private chats, Groups, Channels');
    console.log('📁 Temp directory:', os.tmpdir());
    console.log('🔗 Bot invite link: https://t.me/' + botUsername);

    if (telegramClient) {
        console.log('⚡ Starting MTProto Client for 2GB uploads...');
        try {
            await telegramClient.start({
                botAuthToken: process.env.BOT_TOKEN,
            });
            console.log('✅ MTProto Client Connected! 2GB uploads enabled and progress bar active.');
            // Save session string so we don't need to re-authenticate often
            console.log('Session string (save to .env SESSION_STRING for faster startups):');
            console.log(telegramClient.session.save());
        } catch (e) {
            console.error('❌ Failed to start MTProto Client:', e.message);
            console.log('⚠️ Falling back to 50MB limit standard client.');
        }
    } else {
        console.log('⚠️ API_ID and API_HASH not found in .env. Falling back to 50MB limit standard client.');
    }

    bot.launch()
        .then(() => {
            console.log('✅ Bot started successfully!');
            console.log('🔗 Ready to process MEGA links in all chat types...');
            console.log('\n=== IMPORTANT FOR GROUPS/CHANNELS ===');
            console.log('1. Add bot to group/channel as ADMIN');
            console.log('2. Enable these permissions:');
            console.log('   • Read messages (IMPORTANT!)');
            console.log('   • Send messages');
            console.log('   • Send media');
            console.log('   • Send documents');
            console.log('3. Users can then just send MEGA links');
            console.log('====================================');
        })
        .catch(err => {
            console.error('❌ Failed to start bot:', err);
            process.exit(1);
        });
}).catch(err => {
    console.error('❌ Failed to get bot info:', err);
    process.exit(1);
});

process.once('SIGINT', () => {
    console.log('🛑 Shutting down...');
    bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
    console.log('🛑 Shutting down...');
    bot.stop('SIGTERM');
});
