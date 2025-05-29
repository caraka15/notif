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
const LOG_FILE = path.join(LOG_DIR, 'monitor.log');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth_monitor');

// Interval pengecekan Bioauth
const BIOAUTH_INTERVAL = 5 * 60 * 1000; // 5 menit

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
        case 'BIOAUTH': coloredMessage = chalk.cyan(`[${timestamp}] 🔐 BIOAUTH: ${message}`); break;
        case 'BALANCE': coloredMessage = chalk.magenta(`[${timestamp}] 💰 SALDO: ${message}`); break;
        case 'WHATSAPP': coloredMessage = chalk.blue(`[${timestamp}] 📱 WHATSAPP: ${message}`); break;
        case 'SYSTEM': coloredMessage = chalk.gray(`[${timestamp}] 🔄 SISTEM: ${message}`); break;
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

// Fungsi untuk memperbarui status di allowlist.json
async function updateAllowlistStatus(phoneKey, newStatus) {
    try {
        await logMessage(`Memperbarui status menjadi "${newStatus}" untuk server ${phoneKey} di allowlist.json`, 'SYSTEM');
        const currentAllowlistData = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(currentAllowlistData);
        if (allowlist[phoneKey]) {
            allowlist[phoneKey].status = newStatus;
            await fs.writeFile(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2), 'utf8');
            await logMessage(`Berhasil memperbarui status untuk ${phoneKey} menjadi "${newStatus}"`, 'SUCCESS');
        } else {
            await logMessage(`Kunci telepon ${phoneKey} tidak ditemukan di allowlist.json.`, 'WARN');
        }
    } catch (error) {
        await logMessage(`Error memperbarui status allowlist untuk ${phoneKey}: ${error.message}`, 'ERROR');
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

    // --- FUNGSI startMonitoring DIMODIFIKASI DI SINI ---
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

                        // Logika untuk menentukan penerima notifikasi
                        let targetRecipient = phone; // Default ke nomor pengguna
                        const isAdminManaged = serverConfig.managedAdmin === 1;

                        if (isAdminManaged) {
                            if (ADMIN_WHATSAPP_NUMBER &&
                                ADMIN_WHATSAPP_NUMBER !== 'GANTI_DENGAN_NOMOR_ADMIN_628XXX' && // Pastikan bukan placeholder
                                /^\d+$/.test(ADMIN_WHATSAPP_NUMBER.replace(/@c\.us$/, ''))) { // Cek apakah nomor valid (hanya digit, abaikan @c.us jika ada)
                                targetRecipient = ADMIN_WHATSAPP_NUMBER;
                                await logMessage(`Server ${serverConfig.name} (${serverConfig.address}) dikelola admin. Notifikasi saldo akan dikirim ke Admin (${ADMIN_WHATSAPP_NUMBER}).`, 'BALANCE');
                            } else {
                                await logMessage(`Server ${serverConfig.name} (${serverConfig.address}) dikelola admin, TAPI ADMIN_WHATSAPP_NUMBER ('${ADMIN_WHATSAPP_NUMBER}') tidak valid atau tidak dikonfigurasi. Notifikasi saldo akan dikirim ke user (${phone}).`, 'WARN');
                                // targetRecipient tetap 'phone' (nomor user)
                            }
                        }
                        // Akhir logika penentuan penerima

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
    // --- AKHIR MODIFIKASI FUNGSI startMonitoring ---

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

// Fungsi pembantu untuk menangani berbagai kondisi masalah server
async function handleServerProblem(phone, serverConfig, problemType, details = {}) {
    const initialAllowlistStatus = serverConfig.status || "active";
    let message = "";
    let logDetail = "";
    const problemTypesForCriticalRepeatedNotification = ["BioauthInactive", "ServerDown"];

    // Tambahan info pengelolaan untuk notifikasi
    const isManagedByAdmin = serverConfig.managedAdmin === 1;
    let managementInfoText = "";
    if (isManagedByAdmin) {
        managementInfoText = `\n*(Info: Server ini tercatat dikelola oleh Admin)*`;
    }

    switch (problemType) {
        case "BioauthInactive":
            message = `⛔ *${serverConfig.name}* tidak aktif (Bioauth)!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Tidak Aktif (Bioauth)${managementInfoText}\n\n` +
                (details.authUrl ? `Link Re-autentikasi:\n${details.authUrl}` : 'Link autentikasi tidak tersedia.');
            logDetail = `${serverConfig.name} TIDAK AKTIF (Bioauth)`;
            break;
        case "ServerDown":
            message = `🔴 *${serverConfig.name}* tidak merespons (API Helper melaporkan ServerDown)!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Server Down (pada API Helper ${serverConfig.port})${managementInfoText}\n\n` +
                `Layanan helper API untuk Bioauth mungkin mati. Mohon cek server atau restart layanan helper.`;
            logDetail = `${serverConfig.name} TIDAK DAPAT DIVERIFIKASI (API Helper ServerDown)`;
            break;
        case "InvalidResponse":
            message = `⚠️ *${serverConfig.name}* mengembalikan respons tidak valid dari API Helper!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Respons Tidak Valid (dari API Helper ${serverConfig.port})${managementInfoText}\n` +
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

    const isCriticalProblemType = problemTypesForCriticalRepeatedNotification.includes(problemType);

    // Untuk notifikasi masalah server, kita tetap kirim ke user yang bersangkutan (phone dari allowlist)
    // karena ini berkaitan langsung dengan server milik user tersebut, meskipun dikelola admin.
    // Admin akan mendapat notifikasi saldo, user mendapat notifikasi masalah servernya.
    // Jika ingin notifikasi masalah juga ke admin, logika pengiriman perlu disesuaikan di sini.

    if (isCriticalProblemType) {
        await sendWhatsAppMessage(phone, message);
        if (initialAllowlistStatus !== "inactive") {
            await logMessage(`${logDetail} - Notifikasi KRITIS (menyebabkan status jadi inactive) terkirim ke ${phone.replace('@c.us', '')}. Memperbarui allowlist.`, 'BIOAUTH');
            await updateAllowlistStatus(phone, "inactive");
        } else {
            await logMessage(`${logDetail} - Notifikasi KRITIS BERULANG terkirim ke ${phone.replace('@c.us', '')}. Status allowlist sudah "inactive".`, 'BIOAUTH');
        }
    } else {
        if (initialAllowlistStatus !== "inactive") {
            await sendWhatsAppMessage(phone, message);
            await logMessage(`${logDetail} - Notifikasi PERUBAHAN STATUS (karena error helper) terkirim ke ${phone.replace('@c.us', '')}. Memperbarui allowlist.`, 'BIOAUTH');
            await updateAllowlistStatus(phone, "inactive");
        } else {
            await logMessage(`${logDetail}, dan status di allowlist sudah "inactive". Tidak ada notifikasi berulang untuk error helper ini ke ${phone.replace('@c.us', '')}.`, 'BIOAUTH');
        }
    }
}


// Fungsi Pengecek Bioauth
async function checkBioauth(phone, serverConfig) {
    // initialAllowlistStatus dibaca untuk logika "kembali aktif" dan pembaruan allowlist.json
    const initialAllowlistStatus = serverConfig.status || "active";
    const managementStatus = serverConfig.managedAdmin === 1 ? "Dikelola Admin" : "Dikelola User";
    // managementInfoText digunakan untuk memperkaya pesan notifikasi
    const managementInfoText = serverConfig.managedAdmin === 1 ? "\n*(Info: Server ini tercatat dikelola oleh Admin)*" : "";

    await logMessage(`Memeriksa Bioauth untuk ${serverConfig.name} (${serverConfig.ip}). Pengelolaan: ${managementStatus}. Status allowlist awal: ${initialAllowlistStatus}`, 'BIOAUTH');

    try {
        const response = await axios.get(`http://${serverConfig.ip}:${serverConfig.port}/cek`, {
            timeout: 10000 // Timeout 10 detik untuk koneksi ke API helper
        });
        const data = response.data;

        // 1. Validasi struktur dasar respons dari API helper
        if (!data || !data.status || typeof data.status.result === 'undefined') {
            await logMessage(`Struktur respons API helper tidak valid dari ${serverConfig.name}. Respons: ${JSON.stringify(data)}`, 'WARN');
            // Serahkan ke handleServerProblem untuk notifikasi dan update allowlist
            await handleServerProblem(phone, serverConfig, "InvalidResponse", {
                responseData: JSON.stringify(data),
                note: "Struktur API helper (/cek) tidak sesuai harapan."
            });
            return;
        }

        const apiStatusResult = data.status.result;

        // 2. Tangani status bermasalah yang dilaporkan langsung oleh API helper
        if (apiStatusResult === "Inactive") {
            await logMessage(`${serverConfig.name} Bioauth TIDAK AKTIF menurut API helper. Memanggil handleServerProblem.`, 'BIOAUTH');
            // handleServerProblem akan mengirim notifikasi "Bioauth tidak aktif" dan update allowlist
            await handleServerProblem(phone, serverConfig, "BioauthInactive", { authUrl: data.auth?.url });
            return;
        }

        if (apiStatusResult === "ServerDown") { // Jika API helper melaporkan bahwa server Humanode-nya "down"
            await logMessage(`${serverConfig.name} API Helper melaporkan status ServerDown (server Humanode mungkin mati). Memanggil handleServerProblem.`, 'BIOAUTH');
            await handleServerProblem(phone, serverConfig, "ServerDown");
            return;
        }

        if (apiStatusResult === "InvalidResponse") { // Jika API helper sendiri melaporkan bahwa respons dari node Humanode tidak valid
            await logMessage(`${serverConfig.name} API Helper melaporkan status InvalidResponse (dari node Humanode). Memanggil handleServerProblem.`, 'BIOAUTH');
            await handleServerProblem(phone, serverConfig, "InvalidResponse", {
                responseData: JSON.stringify(data),
                note: "API helper melaporkan InvalidResponse dari node Humanode."
            });
            return;
        }

        // 3. Tangani status "Aktif" yang dilaporkan oleh API helper
        if (typeof apiStatusResult === 'object' && apiStatusResult.Active) {
            await logMessage(`${serverConfig.name} Bioauth AKTIF menurut API helper.`, 'BIOAUTH');

            // Jika status di allowlist.json sebelumnya tidak "active", kirim notifikasi "kembali aktif"
            // dan perbarui status di allowlist.json.
            if (initialAllowlistStatus !== "active") {
                const backToActiveMessage = `✅ *${serverConfig.name}* kembali AKTIF (Bioauth)!${managementInfoText}\n\nIP: ${serverConfig.ip}`;
                await sendWhatsAppMessage(phone, backToActiveMessage);
                await logMessage(`${serverConfig.name} Bioauth telah beralih ke AKTIF. Notifikasi terkirim. Memperbarui allowlist menjadi 'active'.`, 'BIOAUTH');
                await updateAllowlistStatus(phone, "active");
            } else {
                // Jika sudah aktif di allowlist, cukup log konfirmasi
                await logMessage(`${serverConfig.name} Bioauth dikonfirmasi AKTIF (status allowlist sudah 'active'). Lanjut cek kedaluwarsa.`, 'BIOAUTH');
            }

            // Persiapan untuk cek waktu kedaluwarsa
            let remainingMillisecondsFromAPI = 0;
            let formattedRemainingTime = "N/A";

            if (data.status.remaining_time) {
                // Prioritaskan total_milliseconds jika valid dan lebih besar dari 0
                if (typeof data.status.remaining_time.total_milliseconds === 'number' && data.status.remaining_time.total_milliseconds > 0) {
                    remainingMillisecondsFromAPI = data.status.remaining_time.total_milliseconds;
                }
                // Jika total_milliseconds tidak valid/nol, coba hitung dari jam dan menit
                else if (typeof data.status.remaining_time.hours === 'number' && typeof data.status.remaining_time.minutes === 'number') {
                    // Log sebagai warning jika fallback calculation digunakan
                    await logMessage(`WARN: ${serverConfig.name}: 'total_milliseconds' dari API helper tidak valid atau nol. Menghitung sisa waktu dari jam/menit. Data remaining_time: ${JSON.stringify(data.status.remaining_time)}`, 'BIOAUTH');
                    remainingMillisecondsFromAPI =
                        (data.status.remaining_time.hours * 60 * 60 * 1000) +
                        (data.status.remaining_time.minutes * 60 * 1000) +
                        ((data.status.remaining_time.seconds || 0) * 1000); // Tambahkan detik jika ada
                }

                // Format sisa waktu untuk pesan notifikasi
                if (typeof data.status.remaining_time.hours === 'number' && typeof data.status.remaining_time.minutes === 'number') {
                    const totalHours = data.status.remaining_time.hours;
                    const minutes = data.status.remaining_time.minutes;
                    const seconds = data.status.remaining_time.seconds || 0;
                    const days = Math.floor(totalHours / 24);
                    const remainingHoursInDay = totalHours % 24;
                    let parts = [];

                    if (days > 0) parts.push(`${days} hari`);
                    if (remainingHoursInDay > 0) parts.push(`${remainingHoursInDay} jam`);
                    // Tampilkan menit jika > 0 ATAU jika tidak ada hari/jam tapi menit > 0
                    if (minutes > 0 || (days === 0 && remainingHoursInDay === 0 && parts.length === 0)) {
                        parts.push(`${minutes} menit`);
                    }
                    // Tampilkan detik jika tidak ada hari/jam/menit tapi detik > 0
                    if (days === 0 && remainingHoursInDay === 0 && minutes === 0 && seconds > 0 && parts.length === 0) {
                        parts.push(`${seconds} detik`);
                    }
                    // Jika semua 0 tapi ada milidetik positif, sebut "Kurang dari semenit"
                    formattedRemainingTime = parts.length > 0 ? parts.join(' ') : (remainingMillisecondsFromAPI > 0 ? "Kurang dari semenit" : "N/A");
                }
            }

            // Log sisa waktu aktual dari API (berguna untuk debugging)
            await logMessage(`${serverConfig.name}: Deteksi sisa waktu Bioauth dari API: ${formattedRemainingTime} (${remainingMillisecondsFromAPI}ms).`, 'BIOAUTH_DEBUG');

            // Kirim notifikasi peringatan kedaluwarsa jika memenuhi kondisi waktu
            // Pengiriman peringatan ini TIDAK bergantung pada initialAllowlistStatus
            const thirtyMinuteWarningThreshold = 30 * 60 * 1000; // 30 menit
            const twentyFiveMinuteWarningThreshold = 25 * 60 * 1000; // 25 menit
            const fiveMinuteWarningThreshold = 5 * 60 * 1000;    // 5 menit

            if (remainingMillisecondsFromAPI > twentyFiveMinuteWarningThreshold && remainingMillisecondsFromAPI <= thirtyMinuteWarningThreshold) {
                const warningMessage = `🟡 *${serverConfig.name}* Bioauth akan kedaluwarsa dalam ~${formattedRemainingTime}!${managementInfoText}\n\nIP: ${serverConfig.ip}`;
                await sendWhatsAppMessage(phone, warningMessage);
                await logMessage(`${serverConfig.name} Bioauth kedaluwarsa dalam ~${formattedRemainingTime} (rentang 25-30 menit). Peringatan terkirim.`, 'BIOAUTH');
            } else if (remainingMillisecondsFromAPI > 0 && remainingMillisecondsFromAPI <= fiveMinuteWarningThreshold) {
                const urgentWarningMessage = `🔴 *${serverConfig.name}* Bioauth akan kedaluwarsa SEGERA dalam ~${formattedRemainingTime}!${managementInfoText}\n\nIP: ${serverConfig.ip}`;
                await sendWhatsAppMessage(phone, urgentWarningMessage);
                await logMessage(`${serverConfig.name} Bioauth kedaluwarsa SEGERA dalam ~${formattedRemainingTime} (rentang <5 menit). Peringatan darurat terkirim.`, 'BIOAUTH');
            } else {
                // Jika aktif dan tidak dalam periode peringatan, cukup log saja
                await logMessage(`${serverConfig.name} Bioauth aktif, tidak dalam periode peringatan kedaluwarsa.`, 'BIOAUTH');
            }
            return; // Selesai memproses status "Active"
        }

        // 4. Tangani jika `apiStatusResult` adalah nilai yang tidak dikenal/tidak ditangani
        await logMessage(`Status API helper Bioauth tidak dikenal atau tidak tertangani untuk ${serverConfig.name}: "${JSON.stringify(apiStatusResult)}". Data Lengkap: ${JSON.stringify(data)}`, 'WARN');
        await handleServerProblem(phone, serverConfig, "InvalidResponse", {
            responseData: JSON.stringify(data),
            note: `Status API Bioauth tidak dikenal dari helper: "${apiStatusResult}"`
        });

    } catch (error) {
        // 5. Tangani error jaringan atau koneksi saat menghubungi API helper
        if (error.isAxiosError && !error.response && error.code) { // Error jaringan (misal, ENOTFOUND, ECONNREFUSED, ETIMEDOUT)
            await logMessage(`Error koneksi ke helper API Bioauth untuk ${serverConfig.name} (${serverConfig.ip}:${serverConfig.port}): ${error.code} - ${error.message}.`, 'ERROR');
            await handleServerProblem(phone, serverConfig, "ConnectionError", { errorCode: error.code, errorMessage: error.message });
        } else if (error.isAxiosError && error.response) { // Error HTTP dari API helper (misal, 404, 503, 500)
            await logMessage(`Error HTTP dari API helper Bioauth ${serverConfig.name} (${serverConfig.ip}:${serverConfig.port}): Status ${error.response.status}. Data: ${JSON.stringify(error.response.data)}`, 'ERROR');
            await handleServerProblem(phone, serverConfig, "ConnectionError", { errorCode: `HTTP ${error.response.status}`, errorMessage: `API helper mengembalikan status error: ${error.response.status}` });
        } else { // Error tidak terduga lainnya selama proses checkBioauth
            await logMessage(`Error tak terduga di checkBioauth untuk ${serverConfig.name}: ${error.message} (Stack: ${error.stack || 'N/A'})`, 'ERROR');
            // Untuk keamanan, panggil handleServerProblem agar status allowlist minimal tercatat ada masalah tidak terduga
            await handleServerProblem(phone, serverConfig, "ConnectionError", { errorCode: 'UNEXPECTED_CHECK_BIOAUTH_ERROR', errorMessage: error.message });
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
            await new Promise(resolve => setTimeout(resolve, 1000)); // Jeda antar server
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
                        "managedAdmin": 0 // Default: tidak dikelola admin
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
    await balanceMonitor.stopAllMonitoring(); // Hentikan monitor lama jika ada

    await startBioauthChecker(); // Pengecekan awal Bioauth
    BIOAUTH_INTERVAL_ID = setInterval(startBioauthChecker, BIOAUTH_INTERVAL);
    await logMessage(`Pengecek bioauth dijadwalkan setiap ${BIOAUTH_INTERVAL / 60000} menit.`, 'SYSTEM');

    const allowlist = await loadAllowlist();
    if (Object.keys(allowlist).length > 0) {
        if (!balanceMonitor.api || !balanceMonitor.api.isConnected) await balanceMonitor.connect();

        if (balanceMonitor.api && balanceMonitor.api.isConnected) {
            for (const [phone, serverConfig] of Object.entries(allowlist)) {
                if (serverConfig && serverConfig.address && serverConfig.address !== 'Tidak diset' && serverConfig.address.trim() !== '') {
                    // Memulai pemantauan saldo. Logika pengiriman notifikasi (ke user atau admin) ada di dalam startMonitoring.
                    balanceMonitor.startMonitoring(phone, serverConfig).catch(async e => await logMessage(`Gagal memulai monitor saldo ${serverConfig.name}: ${e.message}`, 'ERROR'));
                } else {
                    await logMessage(`Alamat wallet tidak valid atau tidak diset untuk ${serverConfig.name} (${phone}). Lewati monitor saldo.`, 'WARN');
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
        await balanceMonitor.disconnect(); // Pastikan monitor saldo juga dihentikan dan koneksi API diputus
        await client.destroy(); // Hancurkan sesi client lama
        await logMessage('Client WhatsApp lama dihancurkan. Menginisialisasi ulang...', 'SYSTEM');
        await client.initialize();
    } catch (initError) {
        await logMessage(`Error inisialisasi ulang WhatsApp: ${initError.message}`, 'ERROR');
        // Pertimbangkan untuk keluar atau mencoba lagi setelah jeda
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
    isBioauthChecking = true; // Hentikan pengecekan baru agar tidak memulai loop baru
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
    // Coba graceful shutdown bahkan pada error fatal, meskipun mungkin tidak semua sumber daya bisa dibersihkan
    await gracefulShutdown('FATAL_ERROR_MAIN');
    process.exit(1); // Keluar dengan status error
});
