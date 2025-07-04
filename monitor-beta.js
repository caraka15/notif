const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');

// Konfigurasi path
const ROOT_DIR = '/root/notif'; // Pastikan path ini sesuai dengan lingkungan Anda
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist.json');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'monitor_beta.log');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth_monitor_beta');

// --- PERUBAHAN INTERVAL ---
// Interval pengecekan Bioauth (diubah menjadi 1 menit)
const BIOAUTH_INTERVAL = 1 * 60 * 1000; // 1 menit
// Interval notifikasi spam untuk status inactive
const INACTIVE_SPAM_INTERVAL = 5 * 60 * 1000; // 5 menit

// --- PENAMBAHAN KONSTANTA ADMIN WHATSAPP ---
// PENTING: Ganti 'GANTI_DENGAN_NOMOR_ADMIN_628XXX' dengan nomor WhatsApp Admin yang valid (misalnya, '6281234567890')
const ADMIN_WHATSAPP_NUMBER = '6285156371696';
// --- AKHIR PENAMBAHAN KONSTANTA ADMIN WHATSAPP ---

// Kunci untuk pengecekan Bioauth
let isBioauthChecking = false;
let BIOAUTH_INTERVAL_ID;

// Fungsi logging yang ditingkatkan
async function logMessage(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    let coloredMessage;
    switch (type) {
        case 'ERROR': coloredMessage = chalk.red(`[${timestamp}] ❌ ERROR: ${message}`); break;
        case 'WARN': coloredMessage = chalk.yellow(`[${timestamp}] ⚠️ PERINGATAN: ${message}`); break;
        case 'SUCCESS': coloredMessage = chalk.green(`[${timestamp}] ✅ SUKSES: ${message}`); break;
        case 'BIOAUTH': coloredMessage = chalk.cyan(`[${timestamp}] 🔍 BIOAUTH: ${message}`); break;
        case 'BALANCE': coloredMessage = chalk.magenta(`[${timestamp}] 💰 SALDO: ${message}`); break;
        case 'WHATSAPP': coloredMessage = chalk.blue(`[${timestamp}] 📱 WHATSAPP: ${message}`); break;
        case 'SYSTEM': coloredMessage = chalk.gray(`[${timestamp}] ⚙️ SISTEM: ${message}`); break;
        default: coloredMessage = chalk.white(`[${timestamp}] ℹ️ INFO: ${message}`);
    }
    console.log(coloredMessage);
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    try {
        await fs.appendFile(LOG_FILE, logEntry);
    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] ❌ ERROR: Gagal menulis ke file log: ${error.message}`));
    }
}

// Inisialisasi client WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR, clientId: 'monitor-bot' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
    }
});

// Memuat allowlist
async function loadAllowlist() {
    try {
        await logMessage('Memuat allowlist...', 'SYSTEM');
        const data = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(data);
        await logMessage(`Berhasil memuat ${Object.keys(allowlist).length} server dari allowlist`, 'SUCCESS');
        return allowlist;
    } catch (error) {
        if (error.code === 'ENOENT') {
            await logMessage(`File allowlist tidak ditemukan di ${ALLOWLIST_PATH}. Membuat file contoh.`, 'WARN');
            const exampleAllowlist = {
                "6281234567890": {
                    "ip": "IP_SERVER_ANDA",
                    "port": "PORT_API_HELPER_ANDA",
                    "name": "NamaServerAnda1",
                    "address": "AlamatHumanodeWalletAnda_Format_SS58",
                    "status": "active",
                    "managedAdmin": 0 // Default: tidak dikelola admin
                }
            };
            await fs.writeFile(ALLOWLIST_PATH, JSON.stringify(exampleAllowlist, null, 2), 'utf8');
            return exampleAllowlist;
        }
        await logMessage(`Error memuat allowlist: ${error.message}`, 'ERROR');
        return {};
    }
}

// --- FUNGSI UPDATE BARU ---
// Fungsi untuk memperbarui entri di allowlist.json
async function updateAllowlistEntry(phoneKey, updates) {
    try {
        await logMessage(`Memperbarui data untuk server ${phoneKey} di allowlist.json`, 'SYSTEM');
        const currentAllowlistData = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(currentAllowlistData);

        if (allowlist[phoneKey]) {
            // Gabungkan pembaruan dengan data yang ada
            allowlist[phoneKey] = { ...allowlist[phoneKey], ...updates };

            // Hapus field yang nilainya null (untuk membersihkan timestamp)
            Object.keys(allowlist[phoneKey]).forEach(key => {
                if (allowlist[phoneKey][key] === null) {
                    delete allowlist[phoneKey][key];
                }
            });

            await fs.writeFile(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2), 'utf8');
            await logMessage(`Berhasil memperbarui data untuk ${phoneKey}. Perubahan: ${JSON.stringify(updates)}`, 'SUCCESS');
        } else {
            await logMessage(`Kunci telepon ${phoneKey} tidak ditemukan di allowlist.json.`, 'WARN');
        }
    } catch (error) {
        await logMessage(`Error memperbarui allowlist untuk ${phoneKey}: ${error.message}`, 'ERROR');
    }
}

// Kelas Monitor Saldo Humanode
class HumanodeBalanceMonitor {
    constructor() {
        this.wsEndpoint = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io';
        this.api = null;
        this.lastBalances = new Map();
        this.activeSubscriptions = new Map();
    }

    async connect() {
        if (this.api && this.api.isConnected) {
            await logMessage('Sudah terhubung ke Jaringan Humanode.', 'BALANCE');
            return true;
        }
        try {
            await logMessage('Menghubungkan ke Jaringan Humanode...', 'BALANCE');
            const provider = new WsProvider(this.wsEndpoint);
            provider.on('connected', () => logMessage('Provider WS Humanode terhubung.', 'SYSTEM'));
            provider.on('disconnected', async () => {
                await logMessage('Provider WS Humanode terputus. Objek API akan dibersihkan.', 'WARN');
                if (this.api) this.api = null;
            });
            provider.on('error', (err) => logMessage(`Error Provider WS Humanode: ${err.message}`, 'ERROR'));
            this.api = await ApiPromise.create({ provider, ss58Format: 5234 });
            await this.api.isReady;
            await logMessage('Berhasil terhubung ke Jaringan Humanode.', 'SUCCESS');
            return true;
        } catch (error) {
            await logMessage(`Error koneksi API Humanode: ${error.message}`, 'ERROR');
            this.api = null;
            return false;
        }
    }

    async getBalance(address) {
        try {
            if (!this.api || !this.api.isConnected) {
                if (!await this.connect()) throw new Error("Gagal terhubung ke API Humanode untuk getBalance.");
            }
            const { data: balance } = await this.api.query.system.account(address);
            const free = this.api.createType('Balance', balance.free);
            return { free: free.toString(), timestamp: new Date().toISOString() };
        } catch (error) {
            await logMessage(`Error memeriksa saldo untuk ${address}: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    formatBalance(rawBalance) {
        const actualBalance = Number(BigInt(rawBalance)) / Number(BigInt(1_000_000_000_000_000_000));
        return actualBalance.toFixed(2).replace('.', ',');
    }

    async stopMonitoringAddress(address) {
        if (this.activeSubscriptions.has(address)) {
            const unsubscribe = this.activeSubscriptions.get(address);
            if (typeof unsubscribe === 'function') {
                try {
                    unsubscribe();
                    await logMessage(`Berhasil berhenti berlangganan pembaruan saldo untuk: ${address}`, 'BALANCE');
                } catch (e) {
                    await logMessage(`Error saat berhenti berlangganan untuk ${address}: ${e.message}`, 'ERROR');
                }
            }
            this.activeSubscriptions.delete(address);
            this.lastBalances.delete(address);
        }
    }

    async stopAllMonitoring() {
        await logMessage('Menghentikan semua langganan pemantauan saldo aktif...', 'BALANCE');
        const addressesToStop = Array.from(this.activeSubscriptions.keys());
        for (const address of addressesToStop) await this.stopMonitoringAddress(address);
        if (addressesToStop.length > 0) await logMessage('Semua langganan saldo dihentikan.', 'SUCCESS');
        else await logMessage('Tidak ada langganan saldo aktif untuk dihentikan.', 'INFO');
    }

    async startMonitoring(phone, serverConfig) {
        try {
            if (!serverConfig.address || serverConfig.address === 'Tidak diset' || serverConfig.address.trim() === '') {
                await logMessage(`Lewati pemantauan saldo ${serverConfig.name}: Alamat tidak valid.`, 'BALANCE');
                return;
            }
            if (!this.api || !this.api.isConnected) {
                if (!await this.connect()) {
                    await logMessage(`Tidak dapat memulai pemantauan ${serverConfig.name}: Koneksi API Humanode gagal.`, 'ERROR');
                    return;
                }
            }
            if (this.activeSubscriptions.has(serverConfig.address)) {
                await logMessage(`Menghentikan monitor saldo lama untuk ${serverConfig.name} (${serverConfig.address}) sebelum memulai ulang.`, 'BALANCE');
                await this.stopMonitoringAddress(serverConfig.address);
            }
            await logMessage(`Memulai pemantauan saldo ${serverConfig.name}: ${serverConfig.address}`, 'BALANCE');
            const initialBalanceData = await this.getBalance(serverConfig.address);
            this.lastBalances.set(serverConfig.address, initialBalanceData.free);
            await logMessage(`Saldo awal ${serverConfig.name} (${serverConfig.address}): ${this.formatBalance(initialBalanceData.free)} HMND`, 'BALANCE');

            const unsubscribe = await this.api.query.system.account(serverConfig.address, async (accountInfo) => {
                const currentBalance = accountInfo.data.free.toString();
                const lastBalance = this.lastBalances.get(serverConfig.address);
                if (typeof lastBalance !== 'undefined' && BigInt(currentBalance) > BigInt(lastBalance)) {
                    const difference = BigInt(currentBalance) - BigInt(lastBalance);
                    if (difference > BigInt(0)) {
                        const formattedAmount = this.formatBalance(difference.toString());
                        const message = `💰 *Pembaruan Saldo*\n\n*Server:* ${serverConfig.name}\n*Alamat:* ${serverConfig.address}\n*Saldo Masuk:* ${formattedAmount} HMND`;

                        let targetRecipient = phone;
                        const isAdminManaged = serverConfig.managedAdmin === 1;

                        if (isAdminManaged) {
                            if (ADMIN_WHATSAPP_NUMBER &&
                                ADMIN_WHATSAPP_NUMBER !== 'GANTI_DENGAN_NOMOR_ADMIN_628XXX' &&
                                /^\d+$/.test(ADMIN_WHATSAPP_NUMBER.replace(/@c\.us$/, ''))) {
                                targetRecipient = ADMIN_WHATSAPP_NUMBER;
                                await logMessage(`Server ${serverConfig.name} (${serverConfig.address}) dikelola admin. Notifikasi saldo akan dikirim ke Admin (${ADMIN_WHATSAPP_NUMBER}).`, 'BALANCE');
                            } else {
                                await logMessage(`Server ${serverConfig.name} (${serverConfig.address}) dikelola admin, TAPI ADMIN_WHATSAPP_NUMBER ('${ADMIN_WHATSAPP_NUMBER}') tidak valid atau tidak dikonfigurasi. Notifikasi saldo akan dikirim ke user (${phone}).`, 'WARN');
                            }
                        }

                        await sendWhatsAppMessage(targetRecipient, message);
                        await logMessage(`${serverConfig.name} (${serverConfig.address}) +${formattedAmount} HMND. Saldo baru: ${this.formatBalance(currentBalance)} HMND. Notifikasi terkirim ke ${targetRecipient.replace('@c.us', '')}`, 'BALANCE');
                    }
                }
                this.lastBalances.set(serverConfig.address, currentBalance);
            });
            this.activeSubscriptions.set(serverConfig.address, unsubscribe);
            await logMessage(`Berhasil memulai pemantauan saldo ${serverConfig.name} (${serverConfig.address})`, 'SUCCESS');
        } catch (error) {
            await logMessage(`Error memulai pemantauan saldo ${serverConfig.name} (${serverConfig.address}): ${error.message}`, 'ERROR');
        }
    }

    async disconnect() {
        await logMessage('Memutus koneksi HumanodeBalanceMonitor...', 'BALANCE');
        await this.stopAllMonitoring();
        if (this.api && this.api.isConnected) {
            try {
                await this.api.disconnect();
                await logMessage('API Humanode berhasil diputus.', 'SUCCESS');
            } catch (e) {
                await logMessage(`Error memutus API Humanode: ${e.message}`, 'ERROR');
            }
        } else {
            await logMessage('API Humanode sudah terputus atau belum diinisialisasi.', 'INFO');
        }
        this.api = null;
    }
}
const balanceMonitor = new HumanodeBalanceMonitor();


// --- FUNGSI handleServerProblem DIMODIFIKASI TOTAL ---
// Fungsi pembantu untuk menangani berbagai kondisi masalah server
// Fungsi pembantu untuk menangani berbagai kondisi masalah server (VERSI FINAL ON-DEMAND)
async function handleServerProblem(phone, serverConfig, problemType, details = {}) {
    const initialAllowlistStatus = serverConfig.status || "active";
    let message = "";
    let logDetail = "";
    let deadlineMessage = ""; // Variabel untuk pesan deadline

    const isManagedByAdmin = serverConfig.managedAdmin === 1;
    let managementInfoText = isManagedByAdmin ? `\n*(Info: Server ini tercatat dikelola oleh Admin)*` : "";
    const serverWebUrl = `https://hmnd.crxanode.xyz/${serverConfig.name.toLowerCase()}`;

    // --- LOGIKA DEADLINE ON-DEMAND HANYA UNTUK "Inactive" ---
    if (problemType === "BioauthInactive") {
        try {
            // Panggil API HANYA saat dibutuhkan
            await logMessage('Status Inactive terdeteksi. Mengambil data epoch terbaru...', 'SYSTEM');
            const response = await axios.get('https://validator.crxanode.xyz/api/dashboard', { timeout: 10000 });
            const epochData = response.data.webServerEpochProgress;

            if (epochData && epochData.estimatedEpochCompletionTime) {
                const epochEndTime = new Date(epochData.estimatedEpochCompletionTime).getTime();
                const inactiveTime = Date.now();
                const timeUntilEpochEnd = epochEndTime - inactiveTime;
                const twoHoursInMillis = 2 * 60 * 60 * 1000;

                let deadlineText = "";

                if (timeUntilEpochEnd > 0 && timeUntilEpochEnd < twoHoursInMillis) {
                    const formattedDeadline = new Date(epochEndTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta', hour12: false }) + " WIB";
                    deadlineText = `*sebelum ${formattedDeadline} hari ini*`;
                } else {
                    deadlineText = "*dalam 2 jam kedepan*";
                }
                deadlineMessage = `\n\n_Penting: Jika Anda tidak melakukan re-autentikasi ${deadlineText}, Anda berisiko tidak tercatat aktif untuk sesi 4 jam berikutnya._`;
            } else {
                // Fallback jika struktur API berubah atau tidak ada data
                throw new Error("Struktur data epoch tidak valid dari API.");
            }
        } catch (error) {
            await logMessage(`Gagal mengambil data epoch on-demand: ${error.message}. Menggunakan pesan deadline fallback.`, 'WARN');
            deadlineMessage = "\n\n_Penting: Jika Anda tidak melakukan re-autentikasi dalam *2 jam kedepan*, Anda berisiko tidak tercatat aktif untuk sesi 4 jam berikutnya._";
        }
    }

    // Bagian selanjutnya dari fungsi ini tetap sama
    if (problemType === "BioauthInactive") {
        message = `🚳 *${serverConfig.name}* tidak aktif (Bioauth)!\n\n` +
            `WEB: ${serverWebUrl}\n` +
            `Status: Tidak Aktif (Bioauth)${managementInfoText}\n\n` +
            (details.authUrl ? `Link Re-autentikasi:\n${details.authUrl}` : 'Link autentikasi tidak tersedia.') +
            `${deadlineMessage}`; // Pesan deadline ditambahkan di sini

        logDetail = `${serverConfig.name} TIDAK AKTIF (Bioauth)`;

        const now = Date.now();
        const lastNotifTime = serverConfig.lastInactiveNotificationTimestamp || 0;

        if (now - lastNotifTime > INACTIVE_SPAM_INTERVAL) {
            await sendWhatsAppMessage(phone, message);
            await logMessage(`${logDetail} - Notifikasi terkirim ke ${phone.replace('@c.us', '')}. Memperbarui allowlist dan timestamp.`, 'BIOAUTH');
            await updateAllowlistEntry(phone, { status: "inactive", lastInactiveNotificationTimestamp: now });
        } else {
            const timeToWait = Math.round((INACTIVE_SPAM_INTERVAL - (now - lastNotifTime)) / 60000);
            await logMessage(`${logDetail} - Status sudah inactive, notifikasi berikutnya dalam ~${timeToWait} menit. Melewati pengiriman pesan.`, 'BIOAUTH');
        }
        return;
    }

    // Logika untuk masalah lain (ServerDown, ConnectionError, dll)
    switch (problemType) {
        case "ServerDown":
            message = `🔴 *${serverConfig.name}* tidak merespons (API Helper melaporkan ServerDown)!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Server Down (pada API Helper ${serverConfig.port})${managementInfoText}\n\n` +
                `WEB: ${serverWebUrl}\n` +
                `Layanan helper API untuk Bioauth mungkin mati. Mohon cek server atau restart layanan helper.`;
            logDetail = `${serverConfig.name} TIDAK DAPAT DIVERIFIKASI (API Helper ServerDown)`;
            break;
        case "InvalidResponse":
            message = `⚠️ *${serverConfig.name}* mengembalikan respons tidak valid dari API Helper!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Respons Tidak Valid (dari API Helper ${serverConfig.port})${managementInfoText}\n` +
                `WEB: ${serverWebUrl}\n` +
                (details.note ? `Catatan: ${details.note}\n` : '') +
                `Mohon cek server atau lakukan reset pada layanan helper API.`;
            logDetail = `${serverConfig.name} TIDAK DAPAT DIVERIFIKASI (API Helper InvalidResponse ${details.note || ''})`;
            break;
        case "ConnectionError":
            message = `🔌 *${serverConfig.name}* tidak dapat dihubungi (layanan API helper di port ${serverConfig.port})!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Error: ${details.errorCode} (${details.errorMessage || ''})${managementInfoText}\n\n` +
                `Mohon periksa apakah layanan API helper untuk server ini berjalan. Status Bioauth tidak dapat diverifikasi.`;
            logDetail = `${serverConfig.name} TIDAK DAPAT DIVERIFIKASI (Koneksi ke API Helper ${serverConfig.port} gagal: ${details.errorCode})`;
            break;
        default:
            await logMessage(`Tipe masalah tidak dikenal: ${problemType} untuk ${serverConfig.name}`, 'ERROR');
            return;
    }

    if (initialAllowlistStatus !== "inactive") {
        await sendWhatsAppMessage(phone, message);
        await logMessage(`${logDetail} - Notifikasi PERUBAHAN STATUS terkirim ke ${phone.replace('@c.us', '')}. Memperbarui allowlist.`, 'BIOAUTH');
        await updateAllowlistEntry(phone, { status: "inactive" });
    } else {
        await logMessage(`${logDetail}, dan status di allowlist sudah "inactive". Tidak ada notifikasi berulang untuk error helper ini.`, 'BIOAUTH');
    }
}


// Fungsi Pengecek Bioauth
async function checkBioauth(phone, serverConfig) {
    const initialAllowlistStatus = serverConfig.status || "active";
    const managementStatus = serverConfig.managedAdmin === 1 ? "Dikelola Admin" : "Dikelola User";
    const managementInfoText = serverConfig.managedAdmin === 1 ? "\n*(Info: Server ini tercatat dikelola oleh Admin)*" : "";
    const serverWebUrl = `https://hmnd.crxanode.xyz/${serverConfig.name.toLowerCase()}`;

    await logMessage(`Memeriksa Bioauth untuk ${serverConfig.name} (${serverConfig.ip}). Pengelolaan: ${managementStatus}. Status allowlist awal: ${initialAllowlistStatus}`, 'BIOAUTH');

    try {
        const response = await axios.get(`http://${serverConfig.ip}:${serverConfig.port}/cek`, {
            timeout: 10000
        });
        const data = response.data;

        if (!data || !data.status || typeof data.status.result === 'undefined') {
            await logMessage(`Struktur respons API helper tidak valid dari ${serverConfig.name}. Respons: ${JSON.stringify(data)}`, 'WARN');
            await handleServerProblem(phone, serverConfig, "InvalidResponse", {
                responseData: JSON.stringify(data),
                note: "Struktur API helper (/cek) tidak sesuai harapan."
            });
            return;
        }

        const apiStatusResult = data.status.result;

        if (apiStatusResult === "Inactive") {
            await logMessage(`${serverConfig.name} Bioauth TIDAK AKTIF menurut API helper. Memanggil handleServerProblem.`, 'BIOAUTH');
            await handleServerProblem(phone, serverConfig, "BioauthInactive", { authUrl: data.auth?.url });
            return;
        }

        if (apiStatusResult === "ServerDown") {
            await logMessage(`${serverConfig.name} API Helper melaporkan status ServerDown (server Humanode mungkin mati). Memanggil handleServerProblem.`, 'BIOAUTH');
            await handleServerProblem(phone, serverConfig, "ServerDown");
            return;
        }

        if (apiStatusResult === "InvalidResponse") {
            await logMessage(`${serverConfig.name} API Helper melaporkan status InvalidResponse (dari node Humanode). Memanggil handleServerProblem.`, 'BIOAUTH');
            await handleServerProblem(phone, serverConfig, "InvalidResponse", {
                responseData: JSON.stringify(data),
                note: "API helper melaporkan InvalidResponse dari node Humanode."
            });
            return;
        }

        if (typeof apiStatusResult === 'object' && apiStatusResult.Active) {
            // Logika untuk notifikasi "kembali aktif" tetap dipertahankan karena ini adalah event penting.
            if (initialAllowlistStatus !== "active") {
                const backToActiveMessage = `✅ *${serverConfig.name}* kembali AKTIF (Bioauth)!${managementInfoText}\n\nWEB: ${serverWebUrl}`;
                await sendWhatsAppMessage(phone, backToActiveMessage);
                await logMessage(`${serverConfig.name} Bioauth telah beralih ke AKTIF. Notifikasi terkirim. Memperbarui allowlist.`, 'BIOAUTH');
                await updateAllowlistEntry(phone, { status: "active", lastInactiveNotificationTimestamp: null });
            }

            // --- Logika Kalkulasi Waktu (tanpa logging perantara) ---
            let remainingMillisecondsFromAPI = 0;
            let formattedRemainingTime = "N/A";

            if (data.status.remaining_time) {
                if (typeof data.status.remaining_time.total_milliseconds === 'number' && data.status.remaining_time.total_milliseconds > 0) {
                    remainingMillisecondsFromAPI = data.status.remaining_time.total_milliseconds;
                }
                else if (typeof data.status.remaining_time.hours === 'number' && typeof data.status.remaining_time.minutes === 'number') {
                    remainingMillisecondsFromAPI =
                        (data.status.remaining_time.hours * 60 * 60 * 1000) +
                        (data.status.remaining_time.minutes * 60 * 1000) +
                        ((data.status.remaining_time.seconds || 0) * 1000);
                }

                if (typeof data.status.remaining_time.hours === 'number' && typeof data.status.remaining_time.minutes === 'number') {
                    const totalHours = data.status.remaining_time.hours;
                    const minutes = data.status.remaining_time.minutes;
                    const days = Math.floor(totalHours / 24);
                    const remainingHoursInDay = totalHours % 24;
                    let parts = [];
                    if (days > 0) parts.push(`${days} hari`);
                    if (remainingHoursInDay > 0) parts.push(`${remainingHoursInDay} jam`);
                    if (minutes > 0) parts.push(`${minutes} menit`);
                    formattedRemainingTime = parts.length > 0 ? parts.join(' ') : (remainingMillisecondsFromAPI > 0 ? "Kurang dari semenit" : "N/A");
                }
            }

            // --- Logika Peringatan dan Logging yang Sudah Dirampingkan ---
            const thirtyOneMinuteThreshold = 31 * 60 * 1000;
            const twentyNineMinuteThreshold = 29 * 60 * 1000;
            const sixMinuteThreshold = 6 * 60 * 1000;
            const fourMinuteThreshold = 4 * 60 * 1000;

            if (remainingMillisecondsFromAPI > twentyNineMinuteThreshold && remainingMillisecondsFromAPI < thirtyOneMinuteThreshold) {
                const warningMessage = `🟡 *${serverConfig.name}* Bioauth akan kedaluwarsa dalam ~${formattedRemainingTime}!${managementInfoText}\n\nWEB: ${serverWebUrl}\n`;
                await sendWhatsAppMessage(phone, warningMessage);
                await logMessage(`${serverConfig.name} Bioauth kedaluwarsa dalam ~${formattedRemainingTime} (rentang 29-31 menit). Peringatan terkirim.`, 'BIOAUTH');
            } else if (remainingMillisecondsFromAPI > fourMinuteThreshold && remainingMillisecondsFromAPI < sixMinuteThreshold) {
                const urgentWarningMessage = `🔴 *${serverConfig.name}* Bioauth akan kedaluwarsa SEGERA dalam ~${formattedRemainingTime}!${managementInfoText}\n\nWEB: ${serverWebUrl}`;
                await sendWhatsAppMessage(phone, urgentWarningMessage);
                await logMessage(`${serverConfig.name} Bioauth kedaluwarsa SEGERA dalam ~${formattedRemainingTime} (rentang 4-6 menit). Peringatan darurat terkirim.`, 'BIOAUTH');
            } else {
                // --- INI LOG BARU YANG DIRINGKAS ---
                // Hanya log jika status sebelumnya sudah aktif, untuk menghindari duplikasi log saat "kembali aktif"
                if (initialAllowlistStatus === "active") {
                    const statusMessage = `ACTIVE. Sisa waktu: ${formattedRemainingTime}. (OK)`;
                    await logMessage(`${serverConfig.name} Bioauth: ${statusMessage}`, 'BIOAUTH');
                }
            }
            return; // Selesai memproses status "Active"
        }

        await logMessage(`Status API helper Bioauth tidak dikenal untuk ${serverConfig.name}: "${JSON.stringify(apiStatusResult)}".`, 'WARN');
        await handleServerProblem(phone, serverConfig, "InvalidResponse", {
            responseData: JSON.stringify(data),
            note: `Status API Bioauth tidak dikenal dari helper: "${apiStatusResult}"`
        });

    } catch (error) {
        if (error.isAxiosError && !error.response && error.code) {
            await logMessage(`Error koneksi ke helper API Bioauth untuk ${serverConfig.name}: ${error.code}.`, 'ERROR');
            await handleServerProblem(phone, serverConfig, "ConnectionError", { errorCode: error.code, errorMessage: error.message });
        } else if (error.isAxiosError && error.response) {
            await logMessage(`Error HTTP dari API helper ${serverConfig.name}: Status ${error.response.status}.`, 'ERROR');
            await handleServerProblem(phone, serverConfig, "ConnectionError", { errorCode: `HTTP ${error.response.status}`, errorMessage: `API helper mengembalikan status error` });
        } else {
            await logMessage(`Error tak terduga di checkBioauth untuk ${serverConfig.name}: ${error.message}`, 'ERROR');
            await handleServerProblem(phone, serverConfig, "ConnectionError", { errorCode: 'UNEXPECTED_ERROR', errorMessage: error.message });
        }
    }
}

// Fungsi pengiriman pesan WhatsApp
async function sendWhatsAppMessage(phone, message) {
    try {
        const chatId = phone.endsWith('@c.us') ? phone : `${phone}@c.us`;
        await logMessage(`Mencoba mengirim pesan WhatsApp ke ${chatId.replace('@c.us', '')}`, 'WHATSAPP');
        if (client.info) {
            await client.sendMessage(chatId, message);
            await logMessage(`Pesan berhasil terkirim ke ${chatId.replace('@c.us', '')}`, 'SUCCESS');
        } else {
            await logMessage(`Client WhatsApp belum siap. Pesan ke ${chatId.replace('@c.us', '')} tidak terkirim.`, 'WARN');
        }
    } catch (error) {
        await logMessage(`Gagal mengirim pesan WhatsApp ke ${phone.replace('@c.us', '')}: ${error.message}`, 'ERROR');
    }
}

// Runner pengecek Bioauth
async function startBioauthChecker() {
    if (isBioauthChecking) {
        await logMessage('Pengecekan Bioauth sudah berjalan. Melewati siklus ini.', 'BIOAUTH');
        return;
    }
    isBioauthChecking = true;
    await logMessage('Memulai siklus pengecekan Bioauth...', 'BIOAUTH');
    try {
        const allowlist = await loadAllowlist();
        if (Object.keys(allowlist).length === 0) {
            await logMessage('Allowlist kosong. Tidak ada server untuk diperiksa.', 'WARN');
            isBioauthChecking = false;
            return;
        }
        for (const [phone, serverConfig] of Object.entries(allowlist)) {
            if (!serverConfig || !serverConfig.ip || !serverConfig.port || !serverConfig.name) {
                await logMessage(`Melewati konfigurasi server tidak valid untuk ${phone}: ${JSON.stringify(serverConfig)}`, 'WARN');
                continue;
            }
            await checkBioauth(phone, serverConfig);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        await logMessage(`Error selama siklus pengecekan bioauth: ${error.message}`, 'ERROR');
    } finally {
        isBioauthChecking = false;
        await logMessage('Siklus pengecekan Bioauth selesai.', 'BIOAUTH');
    }
}

// Pastikan direktori yang diperlukan ada
async function ensureDirectories() {
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.mkdir(LOG_DIR, { recursive: true });
        await fs.mkdir(AUTH_DIR, { recursive: true });
        await logMessage('Direktori yang diperlukan telah dipastikan.', 'SYSTEM');
        try {
            await fs.access(ALLOWLIST_PATH);
        } catch (e) {
            if (e.code === 'ENOENT') {
                const exampleAllowlist = {
                    "6281234567890": {
                        "ip": "IP_SERVER_ANDA",
                        "port": "PORT_API_HELPER_ANDA",
                        "name": "NamaServerAnda1",
                        "address": "AlamatHumanodeWalletAnda_Format_SS58",
                        "status": "active",
                        "managedAdmin": 0
                    }
                };
                await fs.writeFile(ALLOWLIST_PATH, JSON.stringify(exampleAllowlist, null, 2), 'utf8');
                await logMessage(`Membuat contoh allowlist di ${ALLOWLIST_PATH}. Harap konfigurasikan.`, 'SYSTEM');
            } else { throw e; }
        }
    } catch (error) {
        console.error(chalk.red(`FATAL: Tidak dapat membuat direktori/file: ${error.message}`));
        process.exit(1);
    }
}

// Event handler WhatsApp
client.on('qr', qr => { qrcode.generate(qr, { small: true }); logMessage('Kode QR dihasilkan. Pindai dengan WhatsApp.', 'WHATSAPP'); });

client.on('ready', async () => {
    await logMessage('Client WhatsApp siap.', 'WHATSAPP');
    if (BIOAUTH_INTERVAL_ID) { clearInterval(BIOAUTH_INTERVAL_ID); await logMessage('Interval bioauth lama dibersihkan.', 'SYSTEM'); }
    await balanceMonitor.stopAllMonitoring();

    await startBioauthChecker();
    BIOAUTH_INTERVAL_ID = setInterval(startBioauthChecker, BIOAUTH_INTERVAL);
    await logMessage(`Pengecek bioauth dijadwalkan setiap ${BIOAUTH_INTERVAL / 60000} menit.`, 'SYSTEM');

    const allowlist = await loadAllowlist();
    if (Object.keys(allowlist).length > 0) {
        if (!balanceMonitor.api || !balanceMonitor.api.isConnected) await balanceMonitor.connect();

        if (balanceMonitor.api && balanceMonitor.api.isConnected) {
            for (const [phone, serverConfig] of Object.entries(allowlist)) {
                if (serverConfig && serverConfig.address && serverConfig.address !== 'Tidak diset' && serverConfig.address.trim() !== '') {
                    balanceMonitor.startMonitoring(phone, serverConfig).catch(async e => await logMessage(`Gagal memulai monitor saldo ${serverConfig.name}: ${e.message}`, 'ERROR'));
                } else {
                    await logMessage(`Alamat wallet tidak valid untuk ${serverConfig.name} (${phone}). Lewati monitor saldo.`, 'WARN');
                }
            }
        } else {
            await logMessage('Melewati monitor saldo: API Humanode tidak terhubung.', 'WARN');
        }
    } else {
        await logMessage('Allowlist kosong. Tidak ada monitor saldo dimulai.', 'INFO');
    }
    await logMessage('Sistem diinisialisasi. Monitor berjalan.', 'SUCCESS');
});

client.on('authenticated', () => logMessage('Client WhatsApp terautentikasi.', 'WHATSAPP'));
client.on('auth_failure', async msg => await logMessage(`Autentikasi WhatsApp GAGAL: ${msg}. Hapus folder ${AUTH_DIR} & coba lagi.`, 'ERROR'));

client.on('disconnected', async (reason) => {
    await logMessage(`Client WhatsApp terputus: ${reason}. Mencoba inisialisasi ulang...`, 'WARN');
    try {
        if (BIOAUTH_INTERVAL_ID) { clearInterval(BIOAUTH_INTERVAL_ID); BIOAUTH_INTERVAL_ID = null; }
        await balanceMonitor.disconnect();
        await client.destroy();
        await logMessage('Client WhatsApp lama dihancurkan. Menginisialisasi ulang...', 'SYSTEM');
        await client.initialize();
    } catch (initError) {
        await logMessage(`Error inisialisasi ulang WhatsApp: ${initError.message}`, 'ERROR');
    }
});

// Fungsi utama
async function main() {
    await ensureDirectories();
    await logMessage('Menginisialisasi sistem pemantauan...', 'SYSTEM');
    try {
        await client.initialize();
    } catch (error) {
        await logMessage(`Error inisialisasi client WhatsApp: ${error.message}`, 'ERROR');
        process.exit(1);
    }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
    await logMessage(`Menerima ${signal}. Mematikan dengan anggun...`, 'SYSTEM');
    isBioauthChecking = true;
    if (BIOAUTH_INTERVAL_ID) {
        clearInterval(BIOAUTH_INTERVAL_ID);
        await logMessage('Interval bioauth dibersihkan.', 'SYSTEM');
        BIOAUTH_INTERVAL_ID = null;
    }
    if (balanceMonitor) {
        await balanceMonitor.disconnect();
    }
    if (client) {
        try {
            await client.destroy();
            await logMessage('Client WhatsApp dihancurkan.', 'SYSTEM');
        }
        catch (e) {
            await logMessage(`Error menghancurkan client WhatsApp: ${e.message}`, 'ERROR');
        }
    }
    await logMessage('Proses mematikan selesai.', 'SYSTEM');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main().catch(async error => {
    await logMessage(`Error tidak tertangani di main: ${error.message} ${error.stack || ''}`, 'ERROR');
    await gracefulShutdown('FATAL_ERROR_MAIN');
    process.exit(1);
});
