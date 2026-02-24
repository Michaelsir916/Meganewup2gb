const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const mega = require('megajs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { User, FileLog, ActiveTask, connectDB } = require('./database');
require('dotenv').config();

// Default Telegram Android API configuration to prevent API_ID_INVALID errors.
const DEFAULT_API_ID = 6;
const DEFAULT_API_HASH = 'eb06d4abfb49dc3eeb1aeb98ae0f581e';

const apiId = parseInt(process.env.API_ID) || DEFAULT_API_ID;
const apiHash = process.env.API_HASH || DEFAULT_API_HASH;
const botToken = process.env.BOT_TOKEN;
if (!botToken) {
    console.error("❌ BOT_TOKEN is missing from .env!");
    process.exit(1);
}

// Connect to MongoDB
connectDB();

const stringSession = new StringSession(process.env.SESSION_STRING || '');
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

let botUsername = '';

function cleanMegaLink(link) {
    if (!link) return null;
    let cleanedLink = link.trim()
        .replace(/\s+/g, '')
        .replace(/[\<\>]/g, '');
    if (cleanedLink.includes('mega.nz')) {
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
    return videoExtensions.includes(path.extname(filename).toLowerCase());
}

function isImageFile(filename) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg', '.ico'];
    return imageExtensions.includes(path.extname(filename).toLowerCase());
}

function isAudioFile(filename) {
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus'];
    return audioExtensions.includes(path.extname(filename).toLowerCase());
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

async function sendTelegramFile(event, filePath, fileName, fileSize, progressMsg) {
    const captionText = `${fileName}\nSize: ${formatBytes(fileSize)}`;
    let lastUpdate = 0;

    const progressCallback = async (progress) => {
        const now = Date.now();
        if (now - lastUpdate > 2000 || progress === 1 || progress === 0) {
            lastUpdate = now;
            const percent = Math.round(progress * 100);
            const barLength = 10;
            const filledLength = Math.round(barLength * progress);
            const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

            try {
                if (progressMsg) {
                    await client.editMessage(event.message.peerId, {
                        message: progressMsg.id,
                        text: `📤 *Uploading to Telegram*\n\n[${bar}] ${percent}%\n*File:* \`${fileName}\``,
                        parseMode: 'markdown'
                    });
                }
            } catch (e) {
                // Ignore message not modified errors
            }
        }
    };

    let attributes = [];
    if (isVideoFile(fileName)) {
        attributes.push(new Api.DocumentAttributeVideo({
            w: 1280, h: 720, duration: 0, supportsStreaming: true,
        }));
    } else if (isAudioFile(fileName)) {
        attributes.push(new Api.DocumentAttributeAudio({
            duration: 0, title: path.basename(fileName, path.extname(fileName)), performer: "MEGA Downloader"
        }));
    }

    console.log(`Sending file via MTProto to bypass 50MB limit... ${fileName}`);
    try {
        await client.sendFile(event.message.peerId, {
            file: filePath,
            caption: captionText,
            progressCallback: progressCallback,
            workers: 4,
            attributes: attributes.length > 0 ? attributes : undefined
        });
    } catch (error) {
        console.error(`MTProto upload failed: ${error.message}`);
        throw error;
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
        if (allFiles.length === 0) throw new Error('Folder is empty');
        console.log(`📊 Found ${allFiles.length} files in folder`);

        const folderDir = path.join(tempDir, folder.name);
        if (!fs.existsSync(folderDir)) fs.mkdirSync(folderDir, { recursive: true });

        const downloadedFiles = [];
        const downloadErrors = [];

        for (let i = 0; i < allFiles.length; i++) {
            const file = allFiles[i];
            try {
                console.log(`⬇️  Downloading [${i + 1}/${allFiles.length}]: ${file.name}`);
                const filePath = path.join(folderDir, file.name);
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

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
                        downloadedFiles.push({ path: filePath, name: file.name, size: file.size });
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

        if (downloadedFiles.length === 0) throw new Error('All downloads failed');
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
    const tempDir = path.join(__dirname, 'downloads', userId.toString());
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    return new Promise((resolve, reject) => {
        try {
            const file = mega.File.fromURL(megaUrl, {}, megaStorage || undefined);
            if (!file) throw new Error('Could not parse MEGA URL');

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
                    downloadMegaFolder(file, tempDir).then(resolve).catch(reject);
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
                        resolve({ type: 'file', path: tempPath, name: file.name, size: file.size, tempDir: tempDir });
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

async function processMegaLink(event, megaLink) {
    const sender = await event.message.getSender();
    const userId = sender.id ? sender.id.toString() : 'unknown';
    let activeTaskId = null;
    let localPath = null;
    let tempDir = path.join(__dirname, 'downloads', userId);

    console.log(`📩 Processing MEGA link from user ${userId}`);

    try {
        let statusMsgInfo = await client.sendMessage(event.message.peerId, {
            message: `🔍 *Processing MEGA Link*\n\nChecking link...`,
            parseMode: 'markdown'
        });

        // Create Active Task in DB (guarded — works even if MongoDB is offline)
        try {
            const task = await ActiveTask.create({
                userId,
                megaUrl: megaLink,
                status: 'downloading'
            });
            activeTaskId = task._id;
        } catch (dbErr) {
            console.warn('⚠️ Could not create ActiveTask in DB (MongoDB offline?):', dbErr.message);
        }

        const result = await downloadMegaFile(megaLink, userId);
        localPath = result.path || result.folderPath;

        const editStatus = async (text) => {
            if (statusMsgInfo) {
                try {
                    await client.editMessage(event.message.peerId, {
                        message: statusMsgInfo.id,
                        text: text,
                        parseMode: 'markdown'
                    });
                } catch (editError) { }
            }
        };

        const deleteStatus = async () => {
            if (statusMsgInfo) {
                try {
                    await client.deleteMessages(event.message.peerId, [statusMsgInfo.id], { revoke: true });
                } catch (e) { }
            }
        };

        if (result.type === 'file') {
            try { await ActiveTask.findByIdAndUpdate(activeTaskId, { fileName: result.name, localPath: result.path, status: 'uploading' }); } catch (e) { }

            await editStatus(`✅ *File Loaded*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n📤 Sending to Telegram...`);

            // Check if file is larger than 2GB (Telegram Hard limit)
            const maxFileSize = 2000 * 1024 * 1024; // 2000 MB
            if (result.size > maxFileSize) {
                await editStatus(`❌ *File Too Large*\n\n*Name:* \`${result.name}\`\n*Size:* ${formatBytes(result.size)}\n\n⚠️ Telegram absolute limit for direct bot uploads is 2000MB.`);
                cleanupFile(result.path);
                try { await ActiveTask.findByIdAndDelete(activeTaskId); } catch (e) { }
                return;
            }

            try {
                await sendTelegramFile(event, result.path, result.name, result.size, statusMsgInfo);
                await deleteStatus();

                try {
                    await FileLog.create({ userId, fileName: result.name, fileSize: result.size, megaUrl: megaLink, success: true });
                    await User.findOneAndUpdate({ userId }, { $inc: { totalDownloads: 1, totalBytesDownloaded: result.size } });
                } catch (e) { }
            } catch (sendError) {
                throw sendError;
            }
            cleanupFile(result.path);

        } else if (result.type === 'folder') {
            try { await ActiveTask.findByIdAndUpdate(activeTaskId, { fileName: result.name, localPath: result.folderPath, status: 'uploading' }); } catch (e) { }

            await editStatus(`📦 *Folder Ready*\n\n*Name:* \`${path.basename(result.folderPath)}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}\n\n📤 Starting to send files...`);
            await deleteStatus();

            await client.sendMessage(event.message.peerId, {
                message: `📁 *Folder Download Complete*\n\n*Name:* \`${path.basename(result.folderPath)}\`\n*Files:* ${result.fileCount}\n*Total Size:* ${formatBytes(result.totalSize)}`,
                parseMode: 'markdown'
            });

            let sentCount = 0;
            let failedCount = 0;
            const maxFileSize = 2000 * 1024 * 1024; // 2000 MB Max

            let progressMsg = await client.sendMessage(event.message.peerId, {
                message: `📤 *Sending Files*\n\n✅ Sent: 0/${result.fileCount}\n❌ Failed: 0`,
                parseMode: 'markdown'
            });

            const updateProgress = async () => {
                if (progressMsg) {
                    try {
                        await client.editMessage(event.message.peerId, {
                            message: progressMsg.id,
                            text: `📤 *Sending Files*\n\n✅ Sent: ${sentCount}/${result.fileCount}\n❌ Failed: ${failedCount}`,
                            parseMode: 'markdown'
                        });
                    } catch (e) { }
                }
            };

            for (const file of result.files) {
                try {
                    if (file.size > maxFileSize) {
                        failedCount++;
                        continue;
                    }
                    await updateProgress();
                    await sendTelegramFile(event, file.path, file.name, file.size, progressMsg);
                    sentCount++;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (fileError) {
                    console.error(`Failed to send ${file.name}:`, fileError.message);
                    failedCount++;
                }
            }

            if (progressMsg) {
                try {
                    await client.deleteMessages(event.message.peerId, [progressMsg.id], { revoke: true });
                } catch (e) { }
            }

            cleanupFolder(result.folderPath);

            let summary = `✅ *Folder Transfer Complete!*\n\n`;
            summary += `📁 *Folder:* \`${path.basename(result.folderPath)}\`\n`;
            summary += `📊 *Total Files:* ${result.fileCount}\n`;
            summary += `✅ *Sent Successfully:* ${sentCount}\n`;
            if (failedCount > 0) summary += `❌ *Failed/Skipped:* ${failedCount} (files >2000MB)\n`;
            summary += `💾 *Total Size:* ${formatBytes(result.totalSize)}`;

            await client.sendMessage(event.message.peerId, { message: summary, parseMode: 'markdown' });
        }

        // Final Cleanup
        if (activeTaskId) { try { await ActiveTask.findByIdAndDelete(activeTaskId); } catch (e) { } }
        cleanupFolder(tempDir);

    } catch (error) {
        console.error('❌ Main error:', error.message);

        const errorMessage = `❌ *Process Failed*\n\n*Error:* ${error.message}\n\n*The error has been reported to the Log Channel.*`;

        // Report to Log Channel
        if (logChannelId) {
            try {
                const user = await event.message.getSender();
                const userName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
                const userHandle = user.username ? `@${user.username}` : 'No Username';

                await client.sendMessage(logChannelId, {
                    message: `🚨 *Task Error Report*\n\n*User:* ${userName} (${userHandle})\n*User ID:* \`${userId}\`\n*Link:* ${megaLink}\n\n*Error:* \`${error.message}\``,
                    parseMode: 'markdown'
                });
            } catch (e) {
                console.error("Failed to send error report to log channel:", e.message);
            }
        }

        try { await FileLog.create({ userId, megaUrl: megaLink, success: false, errorMsg: error.message }); } catch (e) { }
        try { await client.sendMessage(event.message.peerId, { message: errorMessage, parseMode: 'markdown' }); } catch (e) { }

        // Final Cleanup on Error
        if (activeTaskId) { try { await ActiveTask.findByIdAndDelete(activeTaskId); } catch (e) { } }
        if (localPath && fs.existsSync(localPath)) {
            // Safely check whether it's a dir or file before cleaning
            try {
                if (fs.lstatSync(localPath).isDirectory()) cleanupFolder(localPath);
                else cleanupFile(localPath);
            } catch (e) {
                console.error('Cleanup stat error:', e.message);
            }
        }
        cleanupFolder(tempDir);
    }
}

client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || message.out) return; // Ignore own messages

    const text = message.message || '';
    const sender = await message.getSender();
    if (!sender) return;

    const senderId = sender.id ? sender.id.toString() : 'unknown';

    // Update tracking db for user
    User.findOneAndUpdate(
        { userId: senderId },
        { $set: { username: sender.username, firstName: sender.firstName, lastActive: Date.now() } },
        { upsert: true, new: true }
    ).catch(e => console.error("DB User Update Error:", e.message));

    if (text.startsWith('/start')) {
        await client.sendMessage(message.peerId, {
            message: `🤖 *MEGA Downloader Bot*\n\nJust send me any MEGA link and I'll download it.\n\n*Supported Formats:*\n• \`https://mega.nz/file/ID#KEY\`\n• \`https://mega.nz/folder/ID#KEY\``,
            parseMode: 'markdown'
        });
        return;
    }

    if (text.startsWith('/help')) {
        await client.sendMessage(message.peerId, {
            message: `📖 *Help*\n\nJust send me any MEGA link and I'll download it for you!\n\n*Valid link formats:*\n✅ \`https://mega.nz/file/ABC123#XYZ456\`\n✅ \`https://mega.nz/folder/DEF789#UVW012\`\n\n*Requirements:*\n• Link must include #key at the end\n• File size must be under 2000MB.`,
            parseMode: 'markdown'
        });
        return;
    }

    const megaLink = cleanMegaLink(text);

    if (!megaLink) {
        if (text && !text.startsWith('/')) {
            await client.sendMessage(message.peerId, {
                message: `❌ *Invalid Source*\n\nThis bot is configured for **MEGA only**.\n\nPlease send a valid MEGA link like:\n\`https://mega.nz/file/ID#KEY\``,
                parseMode: 'markdown'
            });
        }
        return;
    }

    await processMegaLink(event, megaLink);
}, new NewMessage({}));

(async () => {
    console.log('🚀 Starting MEGA Downloader Bot via pure MTProto for 2000MB uploads...');
    try {
        await client.start({
            botAuthToken: botToken,
        });
        const savedSession = client.session.save();

        // Save back into .env to prevent session auth spam tracking!
        const envPath = path.resolve(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            if (envContent.includes('SESSION_STRING=')) {
                envContent = envContent.replace(/SESSION_STRING=.*/g, `SESSION_STRING=${savedSession}`);
            } else {
                envContent += `\nSESSION_STRING=${savedSession}`;
            }
            fs.writeFileSync(envPath, envContent);
        }

        console.log('✅ MTProto Client Connected and 2000MB uploads enabled! Session cached in .env.');
    } catch (e) {
        console.error('❌ Failed to start MTProto Client:', e.message);
        console.error('⚠️ Is your BOT_TOKEN valid? Telegram might have thrown "ACCESS_TOKEN_EXPIRED".');
    }
})();
