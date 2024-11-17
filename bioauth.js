const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Konfigurasi path
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist.json');
const LOG_DIR = '/root/logs';
const LOG_FILE = path.join(LOG_DIR, 'monitor.log');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth_monitor');

// Konfigurasi interval untuk bioauth
const BIOAUTH_INTERVAL = 5 * 60 * 1000; // 5 menit

// Lock untuk bioauth checker
let isBioauthChecking = false;

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

// Inisialisasi WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: AUTH_DIR,
        clientId: 'monitor-bot'
    }),
    puppeteer: {
        headless: true,
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

// Load allowlist
async function loadAllowlist() {
    try {
        await logMessage('Loading allowlist...');
        const data = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(data);
        await logMessage(`Loaded ${Object.keys(allowlist).length} servers from allowlist`);
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

    async startMonitoring(phone, serverConfig) {
        try {
            if (!serverConfig.address || serverConfig.address === 'Tidak diset') {
                await logMessage(`[BALANCE] Skip monitoring for ${serverConfig.name}: No address configured`);
                return;
            }

            if (!this.api) {
                await this.connect();
            }

            await logMessage(`[BALANCE] Start monitoring address: ${serverConfig.address} for ${serverConfig.name}`);

            const initialBalance = await this.getBalance(serverConfig.address);
            this.lastBalances.set(serverConfig.address, initialBalance.free);

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
                        `*Saldo Masuk:* ${formattedAmount} HMND`;

                    await sendWhatsAppMessage(phone, message);
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

// Bioauth Checker Function
async function checkBioauth(phone, serverConfig) {
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

        await logMessage(`[BIOAUTH] Received status for ${serverConfig.name}: ${JSON.stringify(data.status.result)}`);

        // Jika status Inactive
        if (data.status.result === "Inactive") {
            const message = `⛔ *${serverConfig.name}* tidak aktif!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Inactive\n\n` +
                `Link Re-authentication:\n${data.auth.url}`;
            await sendWhatsAppMessage(phone, message);
            await logMessage(`[BIOAUTH] Sent inactive notification to ${phone} for ${serverConfig.name}`);
            return;
        }

        // Cek waktu expired
        const expiresAt = data.status.result.Active.expires_at;
        const now = Date.now();
        const remainingMinutes = Math.floor((expiresAt - now) / (1000 * 60));

        await logMessage(`[BIOAUTH] ${serverConfig.name} expires in ${remainingMinutes} minutes`);

        if (remainingMinutes > 25 && remainingMinutes < 30) {
            const message = `🟡 *${serverConfig.name}* akan expired dalam 30 menit!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Sisa waktu: ${data.status.remaining_time.formatted}\n\n` +
                `Link Re-authentication:\n${data.auth.url}`;
            await sendWhatsAppMessage(phone, message);
            await logMessage(`[BIOAUTH] Sent 30-minute warning to ${phone} for ${serverConfig.name}`);
        } else if (remainingMinutes > 0 && remainingMinutes < 6) {
            const message = `🔴 *${serverConfig.name}* akan expired dalam 5 menit!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Sisa waktu: ${data.status.remaining_time.formatted}\n\n` +
                `Link Re-authentication:\n${data.auth.url}`;
            await sendWhatsAppMessage(phone, message);
            await logMessage(`[BIOAUTH] Sent 5-minute warning to ${phone} for ${serverConfig.name}`);
        }

    } catch (error) {
        await logMessage(`[BIOAUTH] Error checking server ${serverConfig.name}: ${error.message}`);
        if (error.response) {
            await logMessage(`[BIOAUTH] Response error data: ${JSON.stringify(error.response.data)}`);
        }
    }
}

// Fungsi untuk kirim pesan WhatsApp
async function sendWhatsAppMessage(phone, message) {
    try {
        await logMessage(`Sending WhatsApp message to ${phone}`);
        const chatId = `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        await logMessage(`Successfully sent message to ${phone}`);
    } catch (error) {
        await logMessage(`Error sending WhatsApp message to ${phone}: ${error.message}`);
    }
}

// Bioauth checker runner
async function startBioauthChecker() {
    if (isBioauthChecking) {
        await logMessage('[BIOAUTH] Skip: check still in progress');
        return;
    }

    try {
        isBioauthChecking = true;
        await logMessage('[BIOAUTH] Starting check cycle...');
        const allowlist = await loadAllowlist();

        for (const [phone, serverConfig] of Object.entries(allowlist)) {
            await checkBioauth(phone, serverConfig);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        await logMessage(`[BIOAUTH] Error: ${error.message}`);
    } finally {
        isBioauthChecking = false;
        await logMessage('[BIOAUTH] Check cycle completed');
    }
}

// Inisialisasi balance monitor
const balanceMonitor = new HumanodeBalanceMonitor();

// WhatsApp event handlers
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    logMessage('QR Code generated. Please scan with WhatsApp');
});

client.on('ready', async () => {
    await logMessage('WhatsApp client is ready');

    // Start bioauth checker dengan interval
    startBioauthChecker();
    setInterval(startBioauthChecker, BIOAUTH_INTERVAL);

    // Start balance monitoring untuk setiap address
    const allowlist = await loadAllowlist();
    for (const [phone, serverConfig] of Object.entries(allowlist)) {
        balanceMonitor.startMonitoring(phone, serverConfig)
            .catch(async (error) => {
                await logMessage(`[BALANCE] Failed to start monitoring for ${serverConfig.name}: ${error.message}`);
            });
    }

    await logMessage('System initialized - Bioauth checker and Balance monitor running');
});

client.on('authenticated', () => {
    logMessage('WhatsApp client authenticated');
});

client.on('auth_failure', (error) => {
    logMessage(`WhatsApp authentication failed: ${error.message}`);
});

// Start WhatsApp client
logMessage('Initializing monitor...');
client.initialize().catch(async error => {
    await logMessage(`Error initializing WhatsApp client: ${error.message}`);
});

// Handle process termination
process.on('SIGTERM', async () => {
    await logMessage('Received SIGTERM signal');
    await balanceMonitor.disconnect();
    await client.destroy();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await logMessage('Received SIGINT signal');
    await balanceMonitor.disconnect();
    await client.destroy();
    process.exit(0);
});
