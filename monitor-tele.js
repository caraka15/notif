const TelegramBot = require('node-telegram-bot-api');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Konfigurasi
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist-tele.json');
const LOG_DIR = '/root/logs';
const LOG_FILE = path.join(LOG_DIR, 'monitor-tele.log');
const BOT_TOKEN = 'YOUR_MONITOR_BOT_TOKEN';

// Konfigurasi interval
const BIOAUTH_INTERVAL = 5 * 60 * 1000; // 5 menit
const RELOAD_INTERVAL = 5 * 60 * 1000;  // 5 menit untuk reload allowlist

// Lock untuk pengecekan
let isBioauthChecking = false;
let monitoredAddresses = new Set();

// Inisialisasi bot
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Fungsi untuk logging
async function logMessage(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;

    console.log(logEntry.trim());

    try {
        await fs.appendFile(LOG_FILE, logEntry);
    } catch (error) {
        console.error('Error writing to log file:', error);
    }
}

// Load allowlist
async function loadAllowlist() {
    try {
        await logMessage('Loading allowlist...');
        const data = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(data);
        await logMessage(`Loaded ${Object.keys(allowlist).length} entries from allowlist-tele.json`);
        return allowlist;
    } catch (error) {
        await logMessage(`Error loading allowlist: ${error.message}`);
        return {};
    }
}

// Balance Monitor Class
class HumanodeBalanceMonitor {
    constructor() {
        this.wsEndpoint = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io';
        this.api = null;
        this.lastBalances = new Map();
        this.isMonitoring = false;
    }

    async connect() {
        try {
            const provider = new WsProvider(this.wsEndpoint);
            this.api = await ApiPromise.create({
                provider,
                ss58Format: 5234
            });

            await logMessage('[BALANCE] Connected to Humanode Network');
            return true;
        } catch (error) {
            await logMessage(`[BALANCE] Connection error: ${error.message}`);
            throw error;
        }
    }

    async getBalance(address) {
        try {
            if (!this.api) {
                await this.connect();
            }

            const { data: balance } = await this.api.query.system.account(address);
            const free = this.api.createType('Balance', balance.free);

            return {
                free: free.toString(),
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            await logMessage(`[BALANCE] Error checking balance: ${error.message}`);
            throw error;
        }
    }

    formatBalance(rawBalance) {
        const actualBalance = Number(BigInt(rawBalance)) / Number(BigInt(1_000_000_000_000_000_000));
        return actualBalance.toFixed(2).replace('.', ',');
    }

    async startMonitoringAddress(chatId, serverConfig) {
        try {
            if (!serverConfig.address || serverConfig.address === 'Tidak diset') {
                await logMessage(`[BALANCE] Skip monitoring for ${serverConfig.name}: No address configured`);
                return;
            }

            // Skip jika address sudah dimonitor
            if (monitoredAddresses.has(serverConfig.address)) {
                await logMessage(`[BALANCE] Address ${serverConfig.address} already being monitored`);
                return;
            }

            if (!this.api) {
                await this.connect();
            }

            await logMessage(`[BALANCE] Start monitoring address: ${serverConfig.address} for ${serverConfig.name}`);

            const initialBalance = await this.getBalance(serverConfig.address);
            this.lastBalances.set(serverConfig.address, initialBalance.free);
            monitoredAddresses.add(serverConfig.address);

            // Monitor events secara real-time
            await this.api.query.system.account(serverConfig.address, async (accountInfo) => {
                const currentBalance = accountInfo.data.free.toString();
                const lastBalance = this.lastBalances.get(serverConfig.address);

                if (lastBalance && BigInt(currentBalance) > BigInt(lastBalance)) {
                    const difference = BigInt(currentBalance) - BigInt(lastBalance);
                    const formattedAmount = this.formatBalance(difference.toString());

                    const message = `💰 *Balance Update*\n\n` +
                        `*Server:* ${serverConfig.name}\n` +
                        `*Address:* ${serverConfig.address}\n` +
                        `*Saldo:* ${formattedAmount} HMND = Rp. 150.000`;

                    await sendTelegramMessage(chatId, message);
                    await logMessage(`[BALANCE] Balance update for ${serverConfig.name}: +${formattedAmount} HMND`);
                }

                this.lastBalances.set(serverConfig.address, currentBalance);
            });

        } catch (error) {
            await logMessage(`[BALANCE] Error in monitoring: ${error.message}`);
            throw error;
        }
    }

    async disconnect() {
        if (this.api) {
            this.isMonitoring = false;
            await this.api.disconnect();
            await logMessage('[BALANCE] Monitoring stopped');
        }
    }
}

// Fungsi untuk kirim pesan Telegram
async function sendTelegramMessage(chatId, message) {
    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        await logMessage(`Message sent to ${chatId}`);
    } catch (error) {
        await logMessage(`Error sending message to ${chatId}: ${error.message}`);
    }
}

// Fungsi cek bioauth
async function checkBioauth(chatId, serverConfig) {
    try {
        await logMessage(`[BIOAUTH] Checking status for ${serverConfig.name} (${serverConfig.ip})`);

        const response = await axios.get(`http://${serverConfig.ip}:${serverConfig.port}/cek`, {
            timeout: 10000
        });
        const data = response.data;

        if (!data.status || !data.status.result) {
            await logMessage(`[BIOAUTH] Invalid response from ${serverConfig.name}`);
            return;
        }

        // Jika status Inactive
        if (data.status.result === "Inactive") {
            const message = `⛔ *${serverConfig.name}* tidak aktif!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Inactive\n\n` +
                `Link Re-authentication:\n${data.auth.url}`;
            await sendTelegramMessage(chatId, message);
            await logMessage(`[BIOAUTH] Sent inactive notification for ${serverConfig.name}`);
            return;
        }

        // Cek waktu expired
        const expiresAt = data.status.result.Active.expires_at;
        const now = Date.now();
        const remainingMinutes = Math.floor((expiresAt - now) / (1000 * 60));

        if (remainingMinutes > 25 && remainingMinutes < 30) {
            const message = `🟡 *${serverConfig.name}* akan expired dalam 30 menit!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Sisa waktu: ${data.status.remaining_time.formatted}\n\n` +
                `Link Re-authentication:\n${data.auth.url}`;
            await sendTelegramMessage(chatId, message);
            await logMessage(`[BIOAUTH] Sent 30-minute warning for ${serverConfig.name}`);
        } else if (remainingMinutes > 0 && remainingMinutes < 6) {
            const message = `🔴 *${serverConfig.name}* akan expired dalam 5 menit!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Sisa waktu: ${data.status.remaining_time.formatted}\n\n` +
                `Link Re-authentication:\n${data.auth.url}`;
            await sendTelegramMessage(chatId, message);
            await logMessage(`[BIOAUTH] Sent 5-minute warning for ${serverConfig.name}`);
        }

    } catch (error) {
        await logMessage(`[BIOAUTH] Error checking ${serverConfig.name}: ${error.message}`);
    }
}

// Start bioauth checker
async function startBioauthChecker() {
    if (isBioauthChecking) {
        await logMessage('[BIOAUTH] Skip: check still in progress');
        return;
    }

    try {
        isBioauthChecking = true;
        await logMessage('[BIOAUTH] Starting check cycle...');
        const allowlist = await loadAllowlist();

        for (const [chatId, serverConfig] of Object.entries(allowlist)) {
            await checkBioauth(chatId, serverConfig);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        await logMessage(`[BIOAUTH] Error: ${error.message}`);
    } finally {
        isBioauthChecking = false;
        await logMessage('[BIOAUTH] Check cycle completed');
    }
}

// Fungsi untuk mengecek user baru
async function checkNewUsers(balanceMonitor) {
    try {
        const allowlist = await loadAllowlist();

        for (const [chatId, serverConfig] of Object.entries(allowlist)) {
            if (serverConfig.address && !monitoredAddresses.has(serverConfig.address)) {
                await logMessage(`[NEW USER] Starting monitoring for new user: ${serverConfig.name}`);
                await balanceMonitor.startMonitoringAddress(chatId, serverConfig);
            }
        }
    } catch (error) {
        await logMessage(`[NEW USER] Error checking new users: ${error.message}`);
    }
}

// Inisialisasi balance monitor
const balanceMonitor = new HumanodeBalanceMonitor();

// Start monitors
async function startMonitors() {
    try {
        await logMessage('Starting monitors...');

        // Start bioauth checker dengan interval
        startBioauthChecker();
        setInterval(startBioauthChecker, BIOAUTH_INTERVAL);

        // Start balance monitoring untuk setiap server
        const allowlist = await loadAllowlist();
        for (const [chatId, serverConfig] of Object.entries(allowlist)) {
            balanceMonitor.startMonitoringAddress(chatId, serverConfig)
                .catch(async (error) => {
                    await logMessage(`[BALANCE] Failed to start monitoring for ${serverConfig.name}: ${error.message}`);
                });
        }

        // Set interval untuk cek user baru
        setInterval(() => checkNewUsers(balanceMonitor), RELOAD_INTERVAL);

        await logMessage('All monitors started');
    } catch (error) {
        await logMessage(`Error starting monitors: ${error.message}`);
        process.exit(1);
    }
}

// Handle process termination
process.on('SIGTERM', async () => {
    await logMessage('Received SIGTERM signal');
    await balanceMonitor.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await logMessage('Received SIGINT signal');
    await balanceMonitor.disconnect();
    process.exit(0);
});

// Start everything
startMonitors().catch(console.error);
