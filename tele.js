const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Konfigurasi
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist-tele.json');
const BOT_TOKEN = '7399467812:AAHlPKkishpucm7dLAERMIKyjddp5A2ze2Q';

// State untuk registrasi
const registrationState = new Map();

// Inisialisasi bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Load allowlist
async function loadAllowlist() {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            await fsPromises.mkdir(CONFIG_DIR, { recursive: true });
        }

        if (!fs.existsSync(ALLOWLIST_PATH)) {
            const emptyAllowlist = {};
            await fsPromises.writeFile(ALLOWLIST_PATH, JSON.stringify(emptyAllowlist, null, 4));
            return emptyAllowlist;
        }

        const data = await fsPromises.readFile(ALLOWLIST_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading allowlist:', error);
        throw error;
    }
}

// Fungsi untuk mengecek API endpoint
async function checkEndpoint(ip, port) {
    try {
        const response = await axios.get(`http://${ip}:${port}/cek`, { timeout: 5000 });
        return response.data && (response.data.status || response.data.auth);
    } catch (error) {
        return false;
    }
}

// Handle command /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        'Selamat datang di Humanode Monitor Bot!\n\n' +
        'Perintah yang tersedia:\n' +
        '/register - Daftar server baru\n' +
        '/cek - Cek status bioauth\n' +
        '/link - Dapatkan link autentikasi\n' +
        '/web - Tampilkan link dashboard\n' +
        '/bantuan - Tampilkan pesan ini',
        { parse_mode: 'Markdown' }
    );
});

// Handle command /register
bot.onText(/\/register/, async (msg) => {
    const chatId = msg.chat.id;

    if (registrationState.has(chatId)) {
        bot.sendMessage(chatId, '❌ Anda sedang dalam proses registrasi.\nKetik *tidak* untuk membatalkan registrasi yang sedang berjalan.', { parse_mode: 'Markdown' });
        return;
    }

    // Mulai proses registrasi dengan ID Telegram
    registrationState.set(chatId, {
        step: 'ip',
        data: { tg_id: chatId.toString() }
    });

    bot.sendMessage(chatId, `Mulai proses registrasi server.\nID Telegram Anda: ${chatId}\n\nSilakan masukkan IP address:`, { parse_mode: 'Markdown' });
});

// Handle command /bantuan
bot.onText(/\/bantuan/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        'Daftar perintah yang tersedia:\n\n' +
        '/register - Daftar server baru\n' +
        '/cek - Cek status bioauth\n' +
        '/link - Dapatkan link autentikasi\n' +
        '/web - Tampilkan link dashboard\n' +
        '/bantuan - Tampilkan pesan ini\n\n' +
        'Catatan:\n' +
        '- Pastikan server sudah running sebelum registrasi\n' +
        '- Address HMND bersifat opsional untuk monitoring balance',
        { parse_mode: 'Markdown' }
    );
});

// Handle pesan biasa untuk proses registrasi
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Skip jika pesan adalah command
    if (msg.text && msg.text.startsWith('/')) return;

    const currentState = registrationState.get(chatId);
    if (!currentState) return;

    try {
        switch (currentState.step) {
            case 'ip':
                currentState.data.ip = msg.text;
                currentState.step = 'port';
                bot.sendMessage(chatId, 'Masukkan port server:', { parse_mode: 'Markdown' });
                break;

            case 'port':
                currentState.data.port = msg.text;

                // Cek koneksi ke endpoint
                const isEndpointValid = await checkEndpoint(currentState.data.ip, msg.text);
                if (!isEndpointValid) {
                    bot.sendMessage(chatId, '❌ Tidak dapat terhubung ke server. Pastikan:\n1. IP dan Port benar\n2. Server sedang running\n\nSilakan coba lagi dengan /register', { parse_mode: 'Markdown' });
                    registrationState.delete(chatId);
                    return;
                }

                currentState.step = 'name';
                bot.sendMessage(chatId, 'Masukkan nama server:', { parse_mode: 'Markdown' });
                break;

            case 'name':
                currentState.data.name = msg.text;
                currentState.step = 'address';
                bot.sendMessage(chatId,
                    'Masukkan address HMND (opsional):\n\n' +
                    '_Address ini untuk melakukan pengecekan jika humanode sudah didistribusikan._\n\n' +
                    'Ketik *skip* jika tidak ingin mengisi address.',
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'address':
                if (msg.text.toLowerCase() === 'skip') {
                    currentState.data.address = 'Tidak diset';
                } else {
                    currentState.data.address = msg.text;
                }
                currentState.step = 'confirm';

                const confirmMessage = `*Konfirmasi Data Server*\n\n` +
                    `*IP:* ${currentState.data.ip}\n` +
                    `*Port:* ${currentState.data.port}\n` +
                    `*Nama:* ${currentState.data.name}\n` +
                    `*Address HMND:* ${currentState.data.address}\n\n` +
                    `Ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.`;

                bot.sendMessage(chatId, confirmMessage, { parse_mode: 'Markdown' });
                break;

            case 'confirm':
                if (msg.text.toLowerCase() === 'ya') {
                    try {
                        const allowlist = await loadAllowlist();
                        allowlist[chatId] = {
                            ip: currentState.data.ip,
                            port: currentState.data.port,
                            name: currentState.data.name,
                            address: currentState.data.address
                        };
                        await fsPromises.writeFile(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 4));

                        bot.sendMessage(chatId,
                            `✅ Registrasi server berhasil!\n\n` +
                            `*${currentState.data.name} telah terdaftar.*\n` +
                            `ID Telegram: ${chatId}\n\n` +
                            `Gunakan:\n` +
                            `/cek - untuk cek status\n` +
                            `/link - untuk dapat link autentikasi\n` +
                            `/web - untuk dapat link dashboard`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (error) {
                        console.error('Error saving to allowlist:', error);
                        bot.sendMessage(chatId, '❌ Gagal menyimpan data server. Silakan coba lagi dengan /register');
                    }
                } else if (msg.text.toLowerCase() === 'tidak') {
                    bot.sendMessage(chatId, '❌ Registrasi dibatalkan.\n\nGunakan /register untuk memulai registrasi baru.');
                } else {
                    bot.sendMessage(chatId, 'Silakan ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.', { parse_mode: 'Markdown' });
                    break;
                }
                registrationState.delete(chatId);
                break;
        }

        if (currentState && currentState.step !== 'confirm') {
            registrationState.set(chatId, currentState);
        }

    } catch (error) {
        console.error('Error handling registration:', error);
        bot.sendMessage(chatId, '❌ Terjadi kesalahan dalam proses registrasi. Silakan coba lagi dengan /register');
        registrationState.delete(chatId);
    }
});

// Handle command /cek, /link, dan /web
async function handleCommand(chatId, command) {
    try {
        const allowlist = await loadAllowlist();
        const serverConfig = allowlist[chatId];

        if (!serverConfig) {
            bot.sendMessage(chatId, '❌ Server belum terdaftar.\nGunakan /register untuk mendaftarkan server.', { parse_mode: 'Markdown' });
            return;
        }

        const response = await axios.get(`http://${serverConfig.ip}:${serverConfig.port}/cek`);

        switch (command) {
            case 'cek':
                const statusMessage = `*${serverConfig.name}*\n\n*Status Bioauth:*\n${response.data.status.remaining_time.formatted}`;
                bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
                break;

            case 'link':
                const authMessage = `*${serverConfig.name}*\n\n*Link Autentikasi:*\n\n${response.data.auth.url}`;
                bot.sendMessage(chatId, authMessage, { parse_mode: 'Markdown' });
                break;

            case 'web':
                const webMessage = `*${serverConfig.name}*\n\n*Link Dashboard:*\n\nhttp://${serverConfig.ip}:${serverConfig.port}`;
                bot.sendMessage(chatId, webMessage, { parse_mode: 'Markdown' });
                break;
        }
    } catch (error) {
        console.error(`Error handling ${command}:`, error);
        bot.sendMessage(chatId, `❌ Terjadi kesalahan saat mengakses server. Pastikan server sedang running.`, { parse_mode: 'Markdown' });
    }
}

bot.onText(/\/cek/, (msg) => handleCommand(msg.chat.id, 'cek'));
bot.onText(/\/link/, (msg) => handleCommand(msg.chat.id, 'link'));
bot.onText(/\/web/, (msg) => handleCommand(msg.chat.id, 'web'));

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

console.log('Telegram registration bot started...');
