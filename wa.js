const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Path ke root directory
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const MEDIA_DIR = path.join(ROOT_DIR, 'media'); // New directory for temporary media storage

// Create media directory if it doesn't exist
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Set admin number(s) - add your admin phone number here
const ADMIN_NUMBERS = ['6285156371696']; // Replace with your admin number(s)

function loadAllowlist() {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        const allowlistPath = path.join(CONFIG_DIR, 'allowlist.json');
        console.log('Loading allowlist from:', allowlistPath);

        if (!fs.existsSync(allowlistPath)) {
            console.log('Allowlist file tidak ditemukan, membuat file baru...');
            const emptyAllowlist = {};
            fs.writeFileSync(allowlistPath, JSON.stringify(emptyAllowlist, null, 4));
            return emptyAllowlist;
        }

        const data = fs.readFileSync(allowlistPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading allowlist:', error);
        console.error('Path yang dicoba:', path.join(CONFIG_DIR, 'allowlist.json'));
        throw error;
    }
}

// Muat allowlist dengan error handling
let allowlist;
try {
    allowlist = loadAllowlist();
    console.log('Allowlist berhasil dimuat');
} catch (error) {
    console.error('Gagal memuat allowlist, membuat allowlist kosong');
    allowlist = {};
}

// Inisialisasi WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(ROOT_DIR, '.wwebjs_auth')
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// Map to track announcement states
const announcementState = new Map();

// Daftar perintah untuk user biasa
const perintah = `*Perintah yang tersedia:*
#cek - Cek status bioauth dan sisa waktu
#link - Dapatkan link autentikasi
#web - Tampilkan link dashboard
#reset - Reset dan dapatkan link baru
#register - Daftarkan server baru
#unregister - Hapus data server
#bantuan - Tampilkan pesan ini`;

// Daftar perintah admin
const adminPerintah = `*Perintah Admin:*
#announce <pesan> - Kirim pengumuman ke semua user terdaftar
#announce-media - Kirim pengumuman dengan gambar/video ke semua user
#listusers - Tampilkan daftar semua user terdaftar
#stats - Tampilkan statistik server
#updateuser <nomor> <parameter> <nilai> - Update data user

${perintah}`;

// Generate QR Code
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('QR Code telah dibuat, silakan scan');
});

// Event siap
client.on('ready', () => {
    console.log('Bot WhatsApp siap digunakan!');
});

// Format pesan status
async function formatPesanStatus(statusData) {
    try {
        const status = statusData.status;
        if (status.result === "Inactive") {
            return `*Status Bioauth:* INACTIVE\n\nSilakan lakukan autentikasi dengan perintah #link`;
        }

        const totalHours = status.remaining_time.hours;
        const minutes = status.remaining_time.minutes;

        const days = Math.floor(totalHours / 24);
        const remainingHours = totalHours % 24;

        let formattedTime = "";
        if (days > 0) {
            formattedTime += `${days} hari `;
        }
        if (remainingHours > 0 || days > 0) { // Tampilkan jam jika ada hari atau jam tersisa
            formattedTime += `${remainingHours} jam `;
        }
        formattedTime += `${minutes} menit`;

        return `*Status Bioauth:*\nWaktu tersisa: ${formattedTime.trim()}`;
    } catch (error) {
        console.error('Error format pesan status:', error);
        return '❌ Format status tidak valid';
    }
}

// Format pesan auth
function formatPesanAuth(authData) {
    try {
        if (authData.auth && authData.auth.success) {
            return `*Link Autentikasi:*\n\n${authData.auth.url}\n\n_Silakan klik link di atas untuk autentikasi_\n\n_Jika link tidak bisa diakses atau loading terus, gunakan #reset untuk mendapatkan link baru_`;
        }
        return '❌ Link autentikasi tidak tersedia';
    } catch (error) {
        console.error('Error format pesan auth:', error);
        return '❌ Error saat memformat link autentikasi';
    }
}

// Fungsi untuk mendapatkan API endpoint berdasarkan nomor
function getApiEndpoint(number) {
    try {
        const userConfig = allowlist[number];
        if (!userConfig) {
            return null;
        }
        return {
            base: `http://${userConfig.ip}:${userConfig.port}`,
            name: userConfig.name,
            ip: userConfig.ip,
            port: userConfig.port
        };
    } catch (error) {
        console.error('Error get API endpoint:', error);
        return null;
    }
}

const registrationState = new Map();
const unregisterState = new Map();

async function saveToAllowlist(data) {
    try {
        const currentAllowlist = await loadAllowlist();
        currentAllowlist[data.phone] = {
            ip: data.ip,
            port: data.port,
            name: data.name,
            address: data.address
        };
        await fs.promises.writeFile(
            path.join(CONFIG_DIR, 'allowlist.json'),
            JSON.stringify(currentAllowlist, null, 4)
        );
        return true;
    } catch (error) {
        console.error('Error saving allowlist:', error);
        return false;
    }
}

async function removeFromAllowlist(phone) {
    try {
        const currentAllowlist = await loadAllowlist();
        if (!currentAllowlist[phone]) {
            return { success: false, message: 'Server tidak ditemukan' };
        }

        const serverName = currentAllowlist[phone].name;
        delete currentAllowlist[phone];

        await fs.promises.writeFile(
            path.join(CONFIG_DIR, 'allowlist.json'),
            JSON.stringify(currentAllowlist, null, 4)
        );

        return {
            success: true,
            message: `Server ${serverName} berhasil dihapus`
        };
    } catch (error) {
        console.error('Error removing from allowlist:', error);
        return {
            success: false,
            message: 'Terjadi kesalahan saat menghapus data'
        };
    }
}

// Check if a number is an admin
function isAdmin(number) {
    return ADMIN_NUMBERS.includes(number);
}

// Function to download media from message
async function downloadMedia(msg) {
    try {
        if (!msg.hasMedia) return null;

        const media = await msg.downloadMedia();
        const extension = media.mimetype.split('/')[1];
        const filename = `${Date.now()}.${extension}`;
        const filepath = path.join(MEDIA_DIR, filename);

        // Convert base64 to file
        const buffer = Buffer.from(media.data, 'base64');
        fs.writeFileSync(filepath, buffer);

        console.log(`Media downloaded to ${filepath}`);

        return {
            filepath,
            mimetype: media.mimetype,
            filename,
            media
        };
    } catch (error) {
        console.error('Error downloading media:', error);
        return null;
    }
}

// Function to send announcement to all users
async function sendAnnouncement(message, media = null, senderName = 'Admin') {
    try {
        const currentAllowlist = await loadAllowlist();
        const userCount = Object.keys(currentAllowlist).length;
        let sentCount = 0;
        let errorCount = 0;

        const formattedAnnouncement = `*PENGUMUMAN*\n\n${message}\n\n_From: ${senderName}_`;

        for (const number in currentAllowlist) {
            try {
                if (media) {
                    // Send with media
                    await client.sendMessage(`${number}@c.us`, media, { caption: formattedAnnouncement });
                } else {
                    // Send text only
                    await client.sendMessage(`${number}@c.us`, formattedAnnouncement);
                }

                console.log(`Announcement sent to ${number}`);
                sentCount++;
                // Add a small delay to prevent flooding
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`Failed to send announcement to ${number}:`, error);
                errorCount++;
            }
        }

        return {
            success: true,
            totalUsers: userCount,
            sentCount,
            errorCount,
            message: `Pengumuman berhasil dikirim ke ${sentCount} dari ${userCount} user`
        };
    } catch (error) {
        console.error('Error sending announcement:', error);
        return {
            success: false,
            message: 'Terjadi kesalahan saat mengirim pengumuman'
        };
    }
}

// Function to list all registered users
async function listRegisteredUsers() {
    try {
        const currentAllowlist = await loadAllowlist();
        const userCount = Object.keys(currentAllowlist).length;

        if (userCount === 0) {
            return "Tidak ada user yang terdaftar";
        }

        let userList = `*Daftar User Terdaftar (${userCount}):*\n\n`;

        for (const number in currentAllowlist) {
            const userData = currentAllowlist[number];
            userList += `*${userData.name}*\n` +
                `Nomor: ${number}\n` +
                `IP: ${userData.ip}:${userData.port}\n` +
                `Address HMND: ${userData.address || 'Tidak diset'}\n\n`;
        }

        return userList;
    } catch (error) {
        console.error('Error listing users:', error);
        return '❌ Terjadi kesalahan saat mengambil daftar user';
    }
}

// Clean up temporary media files that are older than 1 hour
function cleanupMediaFiles() {
    try {
        const files = fs.readdirSync(MEDIA_DIR);
        const now = Date.now();
        const oneHourMs = 60 * 60 * 1000;

        for (const file of files) {
            const filepath = path.join(MEDIA_DIR, file);
            const stats = fs.statSync(filepath);
            const fileAge = now - stats.mtimeMs;

            if (fileAge > oneHourMs) {
                fs.unlinkSync(filepath);
                console.log(`Deleted old media file: ${filepath}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up media files:', error);
    }
}

// Set up periodic cleanup
setInterval(cleanupMediaFiles, 30 * 60 * 1000); // Run every 30 minutes

// Handle pesan
client.on('message', async msg => {
    try {
        const sender = msg.from.split('@')[0];
        const content = msg.body;
        const contentLower = content.toLowerCase();

        console.log(`Pesan diterima dari ${sender}: ${content}`);
        await msg.react('⏳');

        // Check if sender is admin
        const senderIsAdmin = isAdmin(sender);

        // Check if in announcement state
        if (announcementState.has(sender)) {
            const state = announcementState.get(sender);

            if (state.waitingFor === 'message') {
                // Save the message and wait for media
                announcementState.set(sender, {
                    waitingFor: 'media',
                    message: content
                });

                await msg.reply('✅ Pesan diterima. Sekarang kirim gambar atau video untuk pengumuman.\n\nKetik *batal* untuk membatalkan atau *skip* jika tidak ingin menambahkan media.');
                await msg.react('✅');
                return;
            } else if (state.waitingFor === 'media') {
                if (contentLower === 'batal') {
                    announcementState.delete(sender);
                    await msg.reply('❌ Pengumuman dibatalkan.');
                    await msg.react('❌');
                    return;
                }

                if (contentLower === 'skip') {
                    // Send announcement without media
                    await msg.reply('⏳ Mengirim pengumuman tanpa media ke semua user terdaftar...');

                    const result = await sendAnnouncement(state.message, null, `Admin (${sender})`);

                    if (result.success) {
                        await msg.reply(`✅ ${result.message}`);
                        await msg.react('✅');
                    } else {
                        await msg.reply(`❌ ${result.message}`);
                        await msg.react('❌');
                    }

                    announcementState.delete(sender);
                    return;
                }

                // Check if the message has media
                if (msg.hasMedia) {
                    await msg.reply('⏳ Mengunduh media...');

                    const mediaInfo = await downloadMedia(msg);
                    if (!mediaInfo) {
                        await msg.reply('❌ Gagal mengunduh media. Coba lagi atau ketik *skip* untuk mengirim tanpa media.');
                        await msg.react('❌');
                        return;
                    }

                    await msg.reply('⏳ Mengirim pengumuman dengan media ke semua user terdaftar...');

                    const result = await sendAnnouncement(state.message, mediaInfo.media, `Admin (${sender})`);

                    if (result.success) {
                        await msg.reply(`✅ ${result.message}`);
                        await msg.react('✅');
                    } else {
                        await msg.reply(`❌ ${result.message}`);
                        await msg.react('❌');
                    }

                    announcementState.delete(sender);
                    return;
                } else {
                    await msg.reply('❌ Tidak ada media terdeteksi. Kirim gambar/video atau ketik *skip* untuk melanjutkan tanpa media, atau *batal* untuk membatalkan.');
                    await msg.react('❌');
                    return;
                }
            }
        }

        // Handle admin commands
        if (senderIsAdmin && contentLower === '#announce-media') {
            announcementState.set(sender, {
                waitingFor: 'message'
            });

            await msg.reply('Silakan masukkan pesan pengumuman:');
            await msg.react('✅');
            return;
        }

        if (senderIsAdmin && contentLower.startsWith('#announce ')) {
            const announcement = content.substring('#announce '.length).trim();

            if (announcement.length < 3) {
                await msg.reply('❌ Pesan pengumuman terlalu pendek. Minimal 3 karakter.');
                await msg.react('❌');
                return;
            }

            await msg.reply('⏳ Mengirim pengumuman ke semua user terdaftar...');

            const result = await sendAnnouncement(announcement, null, `Admin (${sender})`);

            if (result.success) {
                await msg.reply(`✅ ${result.message}`);
                await msg.react('✅');
            } else {
                await msg.reply(`❌ ${result.message}`);
                await msg.react('❌');
            }
            return;
        }

        if (senderIsAdmin && contentLower === '#listusers') {
            const userList = await listRegisteredUsers();
            await msg.reply(userList);
            await msg.react('✅');
            return;
        }

        if (senderIsAdmin && contentLower === '#stats') {
            try {
                const currentAllowlist = await loadAllowlist();
                const userCount = Object.keys(currentAllowlist).length;

                let stats = `*Statistik Server*\n\n` +
                    `Total user terdaftar: ${userCount}\n\n`;

                await msg.reply(stats);
                await msg.react('✅');
            } catch (error) {
                console.error('Error getting stats:', error);
                await msg.reply('❌ Terjadi kesalahan saat mengambil statistik');
                await msg.react('❌');
            }
            return;
        }

        // Display admin commands
        if (senderIsAdmin && contentLower === '#bantuan') {
            await msg.reply(adminPerintah);
            await msg.react('✅');
            return;
        }

        // Continue with normal user flow
        // Cek status unregister
        if (unregisterState.get(sender)) {
            if (contentLower === 'ya') {
                const result = await removeFromAllowlist(sender);
                if (result.success) {
                    try {
                        allowlist = await loadAllowlist();
                        console.log('Allowlist berhasil dimuat ulang setelah unregister');
                    } catch (error) {
                        console.error('Error reloading allowlist:', error);
                    }
                    await msg.reply(`✅ ${result.message}`);
                    await msg.react('✅');
                } else {
                    await msg.reply(`❌ ${result.message}`);
                    await msg.react('❌');
                }
            } else if (contentLower === 'batal') {
                await msg.reply('✅ Penghapusan server dibatalkan');
                await msg.react('✅');
            } else {
                await msg.reply('❌ Silakan ketik *ya* untuk konfirmasi atau *batal* untuk membatalkan');
                await msg.react('❌');
                return;
            }
            unregisterState.delete(sender);
            return;
        }

        // Cek jika dalam proses registrasi
        const registrationProcess = registrationState.get(sender);
        if (registrationProcess || contentLower === '#register') {
            // Handle proses registrasi
            if (contentLower === '#register') {
                if (getApiEndpoint(sender)) {
                    await msg.reply('❌ Nomor Anda sudah terdaftar.\n\nGunakan perintah lain seperti #cek, #link, atau #web');
                    await msg.react('❌');
                    return;
                }

                registrationState.set(sender, {
                    step: 'ip',
                    data: { phone: sender }
                });
                await msg.reply('Mulai proses registrasi server.\n\nSilakan masukkan IP address:');
                await msg.react('✅');
                return;
            }

            // Lanjutkan proses registrasi yang sedang berjalan
            switch (registrationProcess.step) {
                case 'ip':
                    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(msg.body)) {
                        await msg.reply('❌ Format IP tidak valid.\n\nSilakan masukkan IP yang benar (contoh: 152.42.227.96):');
                        await msg.react('❌');
                        return;
                    }
                    registrationProcess.data.ip = msg.body;
                    registrationProcess.step = 'port';
                    await msg.reply('Masukkan port server:');
                    await msg.react('✅');
                    break;

                case 'port':
                    if (!/^\d+$/.test(msg.body) || parseInt(msg.body) > 65535 || parseInt(msg.body) < 1) {
                        await msg.reply('❌ Port tidak valid.\n\nSilakan masukkan port yang benar (contoh: 8088):');
                        await msg.react('❌');
                        return;
                    }
                    registrationProcess.data.port = msg.body;
                    registrationProcess.step = 'name';
                    await msg.reply('Masukkan nama server:');
                    await msg.react('✅');
                    break;

                case 'name':
                    if (msg.body.length < 1 || msg.body.length > 30) {
                        await msg.reply('❌ Nama server harus antara 1-30 karakter.\n\nSilakan masukkan nama server:');
                        await msg.react('❌');
                        return;
                    }
                    registrationProcess.data.name = msg.body;
                    registrationProcess.step = 'address';
                    await msg.reply('Masukkan address HMND (opsional):\n\n_Address ini untuk melakukan pengecekan jika humanode sudah didistribusikan._\n\nKetik *skip* jika tidak ingin mengisi address.');
                    await msg.react('✅');
                    break;

                case 'address':
                    if (msg.body.toLowerCase() === 'skip') {
                        registrationProcess.data.address = 'Tidak diset';
                    } else {
                        registrationProcess.data.address = msg.body;
                    }
                    registrationProcess.step = 'confirm';

                    const confirmMessage = `*Konfirmasi Data Server*\n\n` +
                        `*IP:* ${registrationProcess.data.ip}\n` +
                        `*Port:* ${registrationProcess.data.port}\n` +
                        `*Nama:* ${registrationProcess.data.name}\n` +
                        `*Address HMND:* ${registrationProcess.data.address}\n\n` +
                        `Ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.`;
                    await msg.reply(confirmMessage);
                    await msg.react('✅');
                    break;

                case 'confirm':
                    if (msg.body.toLowerCase() === 'ya') {
                        try {
                            const saved = await saveToAllowlist(registrationProcess.data);
                            if (saved) {
                                try {
                                    allowlist = await loadAllowlist();
                                    console.log('Allowlist berhasil dimuat ulang setelah registrasi');
                                } catch (error) {
                                    console.error('Error reloading allowlist:', error);
                                }

                                await msg.reply(`✅ Registrasi server berhasil!\n\n*Server ${registrationProcess.data.name} telah terdaftar.*\n\nSekarang Anda dapat mendapatkan notifikasi jika autentikasi Anda expired, serta Anda dapat menggunakan beberapa command.\n\nGunakan #bantuan untuk melihat daftar command yang tersedia.`);
                                await msg.react('✅');
                            } else {
                                await msg.reply('❌ Gagal menyimpan data server. Silakan coba lagi dengan #register');
                                await msg.react('❌');
                            }
                        } catch (error) {
                            console.error('Error saving to allowlist:', error);
                            await msg.reply('❌ Terjadi kesalahan saat menyimpan data. Silakan coba lagi dengan #register');
                            await msg.react('❌');
                        }
                    } else if (msg.body.toLowerCase() === 'tidak') {
                        await msg.reply('❌ Registrasi dibatalkan.\n\nGunakan #register untuk memulai registrasi baru.');
                        await msg.react('❌');
                    } else {
                        await msg.reply('Silakan ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.');
                        return;
                    }
                    registrationState.delete(sender);
                    break;
            }

            if (registrationProcess && registrationProcess.step !== 'confirm') {
                registrationState.set(sender, registrationProcess);
            }
            return;
        }

        // Cek allowlist untuk perintah non-registrasi
        const apiEndpoint = getApiEndpoint(sender);
        if (!apiEndpoint && contentLower !== '#bantuan' && contentLower !== '#register' && !senderIsAdmin) {
            console.log(`Akses ditolak untuk nomor: ${sender}`);
            await msg.reply('❌ Maaf, Anda tidak memiliki akses ke layanan ini.\n\nGunakan #register untuk mendaftarkan server Anda atau #bantuan untuk melihat daftar perintah.');
            await msg.react('❌');
            return;
        }

        switch (contentLower) {
            case '#cek':
                try {
                    console.log(`Mengecek status untuk ${sender} ke ${apiEndpoint.base}/cek`);
                    const response = await axios.get(`${apiEndpoint.base}/cek`);
                    const statusMessage = await formatPesanStatus(response.data);
                    await msg.reply(`*${apiEndpoint.name}*\n${statusMessage}`);
                    await msg.react('✅');
                } catch (error) {
                    console.error('Error cek status:', error);
                    await msg.reply('❌ Terjadi kesalahan saat mengecek status');
                    await msg.react('❌');
                }
                break;

            case '#link':
                try {
                    console.log(`Mengambil link untuk ${sender} dari ${apiEndpoint.base}/cek`);
                    const response = await axios.get(`${apiEndpoint.base}/cek`);
                    const authMessage = formatPesanAuth(response.data);
                    await msg.reply(`*${apiEndpoint.name}*\n${authMessage}`);
                    await msg.react('✅');
                } catch (error) {
                    console.error('Error ambil link:', error);
                    await msg.reply('❌ Terjadi kesalahan saat mengambil link autentikasi');
                    await msg.react('❌');
                }
                break;

            case '#web':
                try {
                    const message = `*${apiEndpoint.name}*\n\n*Link Dashboard:*\n\nhttp://${apiEndpoint.ip}:${apiEndpoint.port}`;
                    await msg.reply(message);
                    await msg.react('✅');
                } catch (error) {
                    console.error('Error menampilkan link dashboard:', error);
                    await msg.reply('❌ Terjadi kesalahan saat mengambil link dashboard');
                    await msg.react('❌');
                }
                break;

            case '#unregister':
                try {
                    const apiEndpoint = getApiEndpoint(sender);
                    if (!apiEndpoint) {
                        await msg.reply('❌ Anda tidak memiliki server yang terdaftar');
                        await msg.react('❌');
                        return;
                    }

                    const serverInfo = `*${apiEndpoint.name}*\n` +
                        `IP: ${apiEndpoint.ip}\n` +
                        `Port: ${apiEndpoint.port}`;

                    unregisterState.set(sender, true);
                    await msg.reply(
                        `⚠️ *Konfirmasi Penghapusan Server*\n\n` +
                        `Anda akan menghapus server:\n${serverInfo}\n\n` +
                        `Ketik *ya* untuk konfirmasi atau ketik *batal* untuk membatalkan.`
                    );
                    await msg.react('✅');
                } catch (error) {
                    console.error('Error unregister:', error);
                    await msg.reply('❌ Terjadi kesalahan saat menghapus server');
                    await msg.react('❌');
                }
                break;

            case '#reset':
                try {
                    console.log(`Melakukan reset untuk ${sender} ke ${apiEndpoint.base}/reset`);
                    await msg.reply('⏳ Sedang melakukan reset WebSocket...');

                    const response = await axios.get(`${apiEndpoint.base}/reset`);

                    if (response.data.success) {
                        const message = `✅ *Reset WebSocket Berhasil*\n\n` +
                            `*${apiEndpoint.name}*\n` +
                            `*Link Autentikasi Baru:*\n\n` +
                            `${response.data.auth.url}\n\n` +
                            `_Link sudah dapat digunakan untuk autentikasi_`;
                        await msg.reply(message);
                        await msg.react('✅');
                    } else {
                        throw new Error(response.data.message || 'Reset gagal');
                    }
                } catch (error) {
                    console.error('Error reset:', error);
                    await msg.reply('❌ Terjadi kesalahan saat melakukan reset');
                    await msg.react('❌');
                }
                break;

            case '#bantuan':
                if (senderIsAdmin) {
                    await msg.reply(adminPerintah);
                } else {
                    await msg.reply(perintah);
                }
                await msg.react('✅');
                break;

            case 'menu':
            case '#menu':
                try {
                    const isRegistered = !!getApiEndpoint(sender);

                    // Buat template tombol
                    const buttons = [
                        {
                            id: 'btn1',
                            body: isRegistered ? '#cek' : '#register',
                            text: isRegistered ? 'Cek Status' : 'Daftar Server'
                        },
                        {
                            id: 'btn2',
                            body: isRegistered ? '#link' : '#bantuan',
                            text: isRegistered ? 'Dapatkan Link' : 'Bantuan'
                        }
                    ];

                    if (isRegistered) {
                        buttons.push(
                            {
                                id: 'btn3',
                                body: '#web',
                                text: 'Dashboard'
                            },
                            {
                                id: 'btn4',
                                body: '#reset',
                                text: 'Reset'
                            },
                            {
                                id: 'btn5',
                                body: '#bantuan',
                                text: 'Bantuan'
                            }
                        );
                    }

                    // Buat pesan dengan tombol
                    const buttonMessage = new Buttons(
                        isRegistered
                            ? '*Menu Utama*\n\nPilih salah satu perintah di bawah ini:'
                            : '*Menu Utama*\n\nAnda belum terdaftar. Silakan pilih salah satu perintah:',
                        buttons,
                        'Menu Bioauth',
                        'Pilih perintah yang diinginkan'
                    );

                    await client.sendMessage(msg.from, buttonMessage);
                    await msg.react('✅');
                } catch (error) {
                    console.error('Error sending menu buttons:', error);
                    // Fallback ke text biasa jika tombol gagal
                    let menuText = isRegistered
                        ? "*Menu Terdaftar*\n\n#cek - Cek status\n#link - Dapatkan link\n#web - Dashboard\n#reset - Reset\n#bantuan - Bantuan"
                        : "*Menu Default*\n\n#register - Daftar server\n#bantuan - Bantuan";

                    await msg.reply(menuText);
                    await msg.react('❌');
                }
                break;

            default:
                if (contentLower.startsWith('#')) {
                    if (senderIsAdmin) {
                        await msg.reply(adminPerintah);
                    } else {
                        await msg.reply(perintah);
                    }
                    await msg.react('✅');
                } else {
                    await msg.react(''); // Hapus reaksi loading jika bukan command
                }
                break;
        }
    } catch (error) {
        console.error('Error proses pesan:', error);
        try {
            await msg.reply('❌ Terjadi kesalahan sistem');
            await msg.react('❌');
        } catch (replyError) {
            console.error('Error saat mengirim pesan error:', replyError);
        }
    }
});

// Handle error
client.on('auth_failure', () => {
    console.error('Autentikasi gagal');
});

client.on('disconnected', (reason) => {
    console.log('Bot terputus:', reason);
});

// Inisialisasi client
client.initialize().catch(err => {
    console.error('Inisialisasi gagal:', err);
});

// Handle error untuk promise yang tidak tertangani
process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise tidak tertangani:', promise, 'alasan:', reason);
});