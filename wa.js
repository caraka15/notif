const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Path ke root directory
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');

function loadAllowlist() {
    try {
        // Pastikan directory config ada
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        const allowlistPath = path.join(CONFIG_DIR, 'allowlist.json');
        console.log('Loading allowlist from:', allowlistPath);

        if (!fs.existsSync(allowlistPath)) {
            console.log('Allowlist file tidak ditemukan, membuat file baru...');
            // Buat file allowlist.json kosong jika belum ada
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

// Daftar perintah
const perintah = `*Perintah yang tersedia:*
#cek - Cek status bioauth dan sisa waktu
#link - Dapatkan link autentikasi
#web - Tampilkan link dashboard
#reset - Reset dan dapatkan link baru
#register - Daftarkan server baru
#bantuan - Tampilkan pesan ini`;

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
        // Tambahkan pengecekan untuk status Inactive
        if (status.result === "Inactive") {
            return `*Status Bioauth:* INACTIVE\n\nSilakan lakukan autentikasi dengan perintah #link`;
        }
        return `*Status Bioauth:*\nWaktu tersisa: ${status.remaining_time.formatted}`;
    } catch (error) {
        console.error('Error format pesan status:', error);
        return '❌ Format status tidak valid';
    }
}

// Format pesan auth
function formatPesanAuth(authData) {
    try {
        if (authData.auth && authData.auth.success) {
            return `*Link Autentikasi:*\n\n${authData.auth.url}\n\n_Silakan klik link di atas untuk autentikasi_`;
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
            name: userConfig.name
        };
    } catch (error) {
        console.error('Error get API endpoint:', error);
        return null;
    }
}

const registrationState = new Map();

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

// Handle pesan
client.on('message', async msg => {
    try {
        const content = msg.body.toLowerCase();
        const sender = msg.from.split('@')[0];

        console.log(`Pesan diterima dari ${sender}: ${content}`);

        // Cek jika dalam proses registrasi
        const registrationProcess = registrationState.get(sender);
        if (registrationProcess || content === '#register') {
            // Handle proses registrasi
            if (content === '#register') {
                // Cek jika user sudah terdaftar
                if (getApiEndpoint(sender)) {
                    await msg.reply('❌ Nomor Anda sudah terdaftar.\n\nGunakan perintah lain seperti #cek, #link, atau #web');
                    return;
                }

                // Mulai proses registrasi baru
                registrationState.set(sender, {
                    step: 'ip',
                    data: { phone: sender }
                });
                await msg.reply('Mulai proses registrasi server.\n\nSilakan masukkan IP address:');
                return;
            }

            // Lanjutkan proses registrasi yang sedang berjalan
            switch (registrationProcess.step) {
                case 'ip':
                    // Validasi IP
                    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(msg.body)) {
                        await msg.reply('❌ Format IP tidak valid.\n\nSilakan masukkan IP yang benar (contoh: 152.42.227.96):');
                        return;
                    }
                    registrationProcess.data.ip = msg.body;
                    registrationProcess.step = 'port';
                    await msg.reply('Masukkan port server:');
                    break;

                case 'port':
                    // Validasi port
                    if (!/^\d+$/.test(msg.body) || parseInt(msg.body) > 65535 || parseInt(msg.body) < 1) {
                        await msg.reply('❌ Port tidak valid.\n\nSilakan masukkan port yang benar (contoh: 8088):');
                        return;
                    }
                    registrationProcess.data.port = msg.body;
                    registrationProcess.step = 'name';
                    await msg.reply('Masukkan nama server:');
                    break;

                case 'name':
                    if (msg.body.length < 1 || msg.body.length > 30) {
                        await msg.reply('❌ Nama server harus antara 1-30 karakter.\n\nSilakan masukkan nama server:');
                        return;
                    }
                    registrationProcess.data.name = msg.body;
                    registrationProcess.step = 'address';
                    await msg.reply('Masukkan address HMND (opsional):\n\n_Address ini untuk melakukan pengecekan jika humanode sudah didistribusikan._\n\nKetik *skip* jika tidak ingin mengisi address.');
                    break;

                case 'address':
                    if (msg.body.toLowerCase() === 'skip') {
                        registrationProcess.data.address = 'Tidak diset';
                    } else {
                        registrationProcess.data.address = msg.body;
                    }
                    registrationProcess.step = 'confirm';

                    // Tampilkan konfirmasi dengan format yang rapi
                    const confirmMessage = `*Konfirmasi Data Server*\n\n` +
                        `*IP:* ${registrationProcess.data.ip}\n` +
                        `*Port:* ${registrationProcess.data.port}\n` +
                        `*Nama:* ${registrationProcess.data.name}\n` +
                        `*Address HMND:* ${registrationProcess.data.address}\n\n` +
                        `Ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.`;
                    await msg.reply(confirmMessage);
                    break;

                case 'confirm':
                    if (msg.body.toLowerCase() === 'ya') {
                        try {
                            const saved = await saveToAllowlist(registrationProcess.data);
                            if (saved) {
                                // Muat ulang allowlist setelah berhasil save
                                try {
                                    allowlist = await loadAllowlist();
                                    console.log('Allowlist berhasil dimuat ulang setelah registrasi');
                                } catch (error) {
                                    console.error('Error reloading allowlist:', error);
                                }

                                await msg.reply(`✅ Registrasi server berhasil!\n\n*Server ${registrationProcess.data.name} telah terdaftar.*\n\nGunakan:\n#cek - untuk cek status\n#link - untuk dapat link autentikasi\n#web - untuk dapat link dashboard`);
                            } else {
                                await msg.reply('❌ Gagal menyimpan data server. Silakan coba lagi dengan #register');
                            }
                        } catch (error) {
                            console.error('Error saving to allowlist:', error);
                            await msg.reply('❌ Terjadi kesalahan saat menyimpan data. Silakan coba lagi dengan #register');
                        }
                    } else if (msg.body.toLowerCase() === 'tidak') {
                        await msg.reply('❌ Registrasi dibatalkan.\n\nGunakan #register untuk memulai registrasi baru.');
                    } else {
                        await msg.reply('Silakan ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.');
                        registrationState.set(sender, registrationProcess);
                        return;
                    }
                    registrationState.delete(sender);
                    break;
            }

            // Update state
            if (registrationProcess && registrationProcess.step !== 'confirm') {
                registrationState.set(sender, registrationProcess);
            }
            return;
        }

        // Cek allowlist untuk perintah non-registrasi
        const apiEndpoint = getApiEndpoint(sender);
        if (!apiEndpoint && content !== '#bantuan') {
            console.log(`Akses ditolak untuk nomor: ${sender}`);
            await msg.reply('❌ Maaf, Anda tidak memiliki akses ke layanan ini.\n\nGunakan #register untuk mendaftarkan server Anda atau #bantuan untuk melihat daftar perintah.');
            return;
        }

        switch (content) {
            case '#cek':
                try {
                    console.log(`Mengecek status untuk ${sender} ke ${apiEndpoint.base}/cek`);
                    const response = await axios.get(`${apiEndpoint.base}/cek`);
                    const statusMessage = await formatPesanStatus(response.data);
                    await msg.reply(`*${apiEndpoint.name}*\n${statusMessage}`);
                } catch (error) {
                    console.error('Error cek status:', error);
                    await msg.reply('❌ Terjadi kesalahan saat mengecek status');
                }
                break;

            case '#link':
                try {
                    console.log(`Mengambil link untuk ${sender} dari ${apiEndpoint.base}/cek`);
                    const response = await axios.get(`${apiEndpoint.base}/cek`);
                    const authMessage = formatPesanAuth(response.data);
                    await msg.reply(`*${apiEndpoint.name}*\n${authMessage}`);
                } catch (error) {
                    console.error('Error ambil link:', error);
                    await msg.reply('❌ Terjadi kesalahan saat mengambil link autentikasi');
                }
                break;

            case '#bantuan':
                await msg.reply(perintah);
                break;

            case '#register':
                try {
                    const currentState = registrationState.get(sender);

                    // Cek jika user sudah terdaftar
                    if (getApiEndpoint(sender) && !currentState) {
                        await msg.reply('❌ Nomor Anda sudah terdaftar.\n\nGunakan perintah lain seperti #cek, #link, atau #web');
                        return;
                    }

                    if (!currentState) {
                        // Mulai proses registrasi
                        registrationState.set(sender, {
                            step: 'ip',
                            data: { phone: sender }
                        });
                        await msg.reply('Mulai proses registrasi server.\n\nSilakan masukkan IP address:');
                        return;
                    }

                    // Handle setiap langkah registrasi
                    switch (currentState.step) {
                        case 'ip':
                            // Validasi IP
                            if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(msg.body)) {
                                await msg.reply('❌ Format IP tidak valid.\n\nSilakan masukkan IP yang benar (contoh: 152.42.227.96):');
                                return;
                            }
                            currentState.data.ip = msg.body;
                            currentState.step = 'port';
                            await msg.reply('Masukkan port server:');
                            break;

                        case 'port':
                            // Validasi port
                            if (!/^\d+$/.test(msg.body) || parseInt(msg.body) > 65535 || parseInt(msg.body) < 1) {
                                await msg.reply('❌ Port tidak valid.\n\nSilakan masukkan port yang benar (contoh: 8088):');
                                return;
                            }
                            currentState.data.port = msg.body;
                            currentState.step = 'name';
                            await msg.reply('Masukkan nama server:');
                            break;

                        case 'name':
                            if (msg.body.length < 1 || msg.body.length > 30) {
                                await msg.reply('❌ Nama server harus antara 1-30 karakter.\n\nSilakan masukkan nama server:');
                                return;
                            }
                            currentState.data.name = msg.body;
                            currentState.step = 'address';
                            await msg.reply('Masukkan address HMND:');
                            break;

                        case 'address':
                            // Validasi format address HMND
                            if (!/^0x[a-fA-F0-9]{40}$/.test(msg.body)) {
                                await msg.reply('❌ Format address HMND tidak valid.\n\nSilakan masukkan address yang benar (contoh: 0x1234...):');
                                return;
                            }
                            currentState.data.address = msg.body;
                            currentState.step = 'confirm';

                            // Tampilkan konfirmasi dengan format yang rapi
                            const confirmMessage = `*Konfirmasi Data Server*\n\n` +
                                `*IP:* ${currentState.data.ip}\n` +
                                `*Port:* ${currentState.data.port}\n` +
                                `*Nama:* ${currentState.data.name}\n` +
                                `*Address HMND:* ${currentState.data.address}\n\n` +
                                `Ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.`;
                            await msg.reply(confirmMessage);
                            break;

                        case 'confirm':
                            if (msg.body.toLowerCase() === 'ya') {
                                try {
                                    const saved = await saveToAllowlist(currentState.data);
                                    if (saved) {
                                        await msg.reply(`✅ Registrasi server berhasil!\n\n*Server ${currentState.data.name} telah terdaftar.*\n\nGunakan:\n#cek - untuk cek status\n#link - untuk dapat link autentikasi\n#web - untuk dapat link dashboard`);
                                    } else {
                                        await msg.reply('❌ Gagal menyimpan data server. Silakan coba lagi dengan #register');
                                    }
                                } catch (error) {
                                    console.error('Error saving to allowlist:', error);
                                    await msg.reply('❌ Terjadi kesalahan saat menyimpan data. Silakan coba lagi dengan #register');
                                }
                            } else if (msg.body.toLowerCase() === 'tidak') {
                                await msg.reply('❌ Registrasi dibatalkan.\n\nGunakan #register untuk memulai registrasi baru.');
                            } else {
                                await msg.reply('Silakan ketik *ya* untuk konfirmasi atau *tidak* untuk membatalkan.');
                                return; // Jangan hapus state karena masih menunggu konfirmasi yang valid
                            }
                            // Hapus state setelah selesai atau dibatalkan
                            registrationState.delete(sender);
                            break;
                    }

                    // Update state jika proses masih berlanjut
                    if (currentState && currentState.step !== 'confirm') {
                        registrationState.set(sender, currentState);
                    }

                } catch (error) {
                    console.error('Error handling registration:', error);
                    await msg.reply('❌ Terjadi kesalahan dalam proses registrasi. Silakan coba lagi dengan #register');
                    registrationState.delete(sender);
                }
                break;

            default:
                if (content.startsWith('#')) {
                    await msg.reply(perintah);
                }
                break;
        }
    } catch (error) {
        console.error('Error proses pesan:', error);
        try {
            await msg.reply('❌ Terjadi kesalahan sistem');
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