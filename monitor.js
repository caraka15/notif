const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const chalk = require('chalk'); // Add this dependency for colored logs

// Configuration paths
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist.json');
const LOG_DIR = '/root/logs';
const LOG_FILE = path.join(LOG_DIR, 'monitor.log');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth_monitor');

// Bioauth check interval
const BIOAUTH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Bioauth checker lock
let isBioauthChecking = false;

// Enhanced logging function
async function logMessage(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    let coloredMessage;

    // Color coding based on message type
    switch (type) {
        case 'ERROR':
            coloredMessage = chalk.red(`[${timestamp}] ❌ ERROR: ${message}`);
            break;
        case 'WARN':
            coloredMessage = chalk.yellow(`[${timestamp}] ⚠️ WARN: ${message}`);
            break;
        case 'SUCCESS':
            coloredMessage = chalk.green(`[${timestamp}] ✅ SUCCESS: ${message}`);
            break;
        case 'BIOAUTH':
            coloredMessage = chalk.cyan(`[${timestamp}] 🔐 BIOAUTH: ${message}`);
            break;
        case 'BALANCE':
            coloredMessage = chalk.magenta(`[${timestamp}] 💰 BALANCE: ${message}`);
            break;
        case 'WHATSAPP':
            coloredMessage = chalk.green(`[${timestamp}] 📱 WHATSAPP: ${message}`);
            break;
        case 'SYSTEM':
            coloredMessage = chalk.blue(`[${timestamp}] 🔄 SYSTEM: ${message}`);
            break;
        default:
            coloredMessage = chalk.white(`[${timestamp}] ℹ️ INFO: ${message}`);
    }

    // Log to console with formatting
    console.log(coloredMessage);

    // Write to log file (without colors)
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    try {
        await fs.appendFile(LOG_FILE, logEntry);
    } catch (error) {
        console.error(chalk.red(`[${timestamp}] ❌ ERROR: Failed to write to log file: ${error.message}`));
    }
}

// WhatsApp client initialization
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
        await logMessage('Loading allowlist...', 'SYSTEM');
        const data = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(data);
        await logMessage(`Loaded ${Object.keys(allowlist).length} servers from allowlist`, 'SUCCESS');
        return allowlist;
    } catch (error) {
        await logMessage(`Error loading allowlist: ${error.message}`, 'ERROR');
        return {}; // Return empty object on error to prevent crashes
    }
}

// Function to update status in allowlist.json
async function updateAllowlistStatus(phoneKey, newStatus) {
    try {
        await logMessage(`Updating status to "${newStatus}" for server associated with ${phoneKey} in allowlist.json`, 'SYSTEM');
        const currentAllowlistData = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(currentAllowlistData);

        if (allowlist[phoneKey]) {
            allowlist[phoneKey].status = newStatus; // Add or update the status field
            await fs.writeFile(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2), 'utf8');
            await logMessage(`Successfully updated status for ${phoneKey} to "${newStatus}" in allowlist.json`, 'SUCCESS');
        } else {
            await logMessage(`Phone key ${phoneKey} not found in allowlist.json. Cannot update status.`, 'WARN');
        }
    } catch (error) {
        await logMessage(`Error updating allowlist status for ${phoneKey}: ${error.message}`, 'ERROR');
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
                ss58Format: 5234 // Humanode SS58 prefix
            });

            await logMessage('Connected to Humanode Network', 'BALANCE');
            return true;
        } catch (error) {
            await logMessage(`Connection error: ${error.message}`, 'ERROR');
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
            await logMessage(`Error checking balance: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    formatBalance(rawBalance) {
        // Humanode uses 18 decimal places
        const actualBalance = Number(BigInt(rawBalance)) / Number(BigInt(1_000_000_000_000_000_000));
        return actualBalance.toFixed(2).replace('.', ','); // Format with 2 decimal places and comma as separator
    }

    async startMonitoring(phone, serverConfig) {
        try {
            if (!serverConfig.address || serverConfig.address === 'Tidak diset') {
                await logMessage(`Skip monitoring for ${serverConfig.name}: No address configured`, 'BALANCE');
                return;
            }

            if (!this.api) {
                await this.connect();
            }

            await logMessage(`Monitoring address for ${serverConfig.name}`, 'BALANCE');

            const initialBalance = await this.getBalance(serverConfig.address);
            this.lastBalances.set(serverConfig.address, initialBalance.free);

            // Monitor events in real-time
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
                    await logMessage(`${serverConfig.name} received +${formattedAmount} HMND`, 'BALANCE');
                }

                this.lastBalances.set(serverConfig.address, currentBalance);
            });

        } catch (error) {
            await logMessage(`Error monitoring ${serverConfig.name}: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async disconnect() {
        if (this.api) {
            this.isMonitoring = false; // This flag might need better management if multiple monitors are stopped individually
            await this.api.disconnect();
            await logMessage('Monitoring stopped', 'BALANCE');
        }
    }
}

// Bioauth Checker Function
async function checkBioauth(phone, serverConfig) {
    try {
        // Determine initial status from allowlist (default to "active" if not present)
        const initialAllowlistStatus = serverConfig.status || "active";
        await logMessage(`Checking Bioauth for ${serverConfig.name} (${serverConfig.ip}). Initial allowlist status: ${initialAllowlistStatus}`, 'BIOAUTH');

        const response = await axios.get(`http://${serverConfig.ip}:${serverConfig.port}/cek`, {
            timeout: 10000 // 10 seconds timeout
        });
        const data = response.data;

        // 1. Basic validation of API response structure
        if (!data || !data.status || !data.status.result) {
            await logMessage(`Invalid API response structure from ${serverConfig.name}. Response: ${JSON.stringify(data)}`, 'BIOAUTH');
            // No notification here, as it's an unexpected API format. Log is important.
            return;
        }

        // 2. Handle definitive "ServerDown" status from API
        // This means the API endpoint itself reported the bioauth service is down.
        if (data.status.result === "ServerDown") {
            const message = `🔴 *${serverConfig.name}* tidak merespons (API melaporkan ServerDown)!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Server Down\n\n` +
                `Layanan Bioauth mungkin mati. Mohon cek server atau restart layanan.`;
            await sendWhatsAppMessage(phone, message);
            await logMessage(`${serverConfig.name} is DOWN (API reported) - notification sent`, 'BIOAUTH');
            // No status change in allowlist for ServerDown, as it's a service issue, not bioauth session state.
            return;
        }

        // 3. Handle definitive "InvalidResponse" status from API
        // This means the API endpoint reported the bioauth service gave an invalid response.
        if (data.status.result === "InvalidResponse") {
            const message = `⚠️ *${serverConfig.name}* mengembalikan respons yang tidak valid (API melaporkan InvalidResponse)!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Invalid Response\n\n` +
                `Mohon cek server atau lakukan reset.`;
            await sendWhatsAppMessage(phone, message);
            await logMessage(`${serverConfig.name} returned invalid response (API reported) - notification sent`, 'BIOAUTH');
            // No status change in allowlist for InvalidResponse.
            return;
        }

        // 4. Handle "Inactive" status from API (Bioauth session is inactive)
        if (data.status.result === "Inactive") {
            const message = `⛔ *${serverConfig.name}* tidak aktif (Bioauth)!\n\n` +
                `IP: ${serverConfig.ip}\n` +
                `Status: Inactive\n\n` +
                (data.auth && data.auth.url ? `Link Re-authentication:\n${data.auth.url}` : 'Link otentikasi tidak tersedia.');
            await sendWhatsAppMessage(phone, message); // Send notification regardless of previous state
            await logMessage(`${serverConfig.name} is INACTIVE (Bioauth) - notification sent`, 'BIOAUTH');

            if (initialAllowlistStatus === "active") {
                // Transition: Active (in allowlist) -> Inactive (from API)
                await logMessage(`${serverConfig.name} was 'active' in allowlist, API reports 'Inactive'. Updating allowlist to 'inactive'.`, 'BIOAUTH');
                await updateAllowlistStatus(phone, "inactive");
            } else {
                // Already Inactive in allowlist, and API confirms Inactive
                await logMessage(`${serverConfig.name} was already 'inactive' in allowlist and API confirms. No allowlist status change needed.`, 'BIOAUTH');
            }
            return; // Exit after handling Inactive status
        }

        // 5. Handle "Active" status from API (Bioauth session is active)
        if (typeof data.status.result === 'object' && data.status.result.Active) {
            // API reports the node is Active
            if (initialAllowlistStatus === "inactive") {
                // Transition: Inactive (in allowlist) -> Active (from API)
                const message = `✅ *${serverConfig.name}* kembali AKTIF!\n\n` +
                    `IP: ${serverConfig.ip}`;
                await sendWhatsAppMessage(phone, message);
                await logMessage(`${serverConfig.name} has transitioned from INACTIVE to ACTIVE. Notification sent. Updating allowlist.`, 'BIOAUTH');
                await updateAllowlistStatus(phone, "active");
            } else {
                // State: Active (in allowlist) -> Active (from API) or New/Undefined (in allowlist) -> Active (from API)
                if (initialAllowlistStatus !== "active") {
                    await logMessage(`${serverConfig.name} is ACTIVE (API). Initial allowlist status was '${initialAllowlistStatus}'. Updating allowlist to 'active'.`, 'BIOAUTH');
                    await updateAllowlistStatus(phone, "active"); // Ensure allowlist is marked active
                } else {
                    await logMessage(`${serverConfig.name} is confirmed ACTIVE. Proceeding with expiration checks.`, 'BIOAUTH');
                }
            }

            // Proceed with expiration warnings for active nodes
            const expiresAt = data.status.result.Active.expires_at;
            const now = Date.now();
            const remainingMilliseconds = expiresAt - now;

            let formattedRemainingTime = "N/A";
            if (data.status.remaining_time && typeof data.status.remaining_time.hours === 'number' && typeof data.status.remaining_time.minutes === 'number') {
                const totalHours = data.status.remaining_time.hours;
                const minutes = data.status.remaining_time.minutes;
                const days = Math.floor(totalHours / 24);
                const remainingHoursInDay = totalHours % 24;

                let parts = [];
                if (days > 0) parts.push(`${days} hari`);
                if (remainingHoursInDay > 0 || days > 0) parts.push(`${remainingHoursInDay} jam`);
                parts.push(`${minutes} menit`);
                formattedRemainingTime = parts.join(' ');
            }

            const thirtyMinuteWarningThreshold = 30;
            const fiveMinuteWarningThreshold = 5;
            const remainingMinutes = Math.floor(remainingMilliseconds / (1000 * 60));

            // Only send expiration warnings if it was already known to be active to avoid notification spam on "kembali aktif"
            if (initialAllowlistStatus === "active") {
                if (remainingMinutes > (thirtyMinuteWarningThreshold - 5) && remainingMinutes <= thirtyMinuteWarningThreshold) {
                    const message = `🟡 *${serverConfig.name}* akan expired dalam ~30 menit!\n\n` +
                        `IP: ${serverConfig.ip}\n` +
                        `Sisa waktu: ${formattedRemainingTime}\n\n` +
                        (data.auth && data.auth.url ? `Link Re-authentication:\n${data.auth.url}` : 'Link otentikasi tidak tersedia.');
                    await sendWhatsAppMessage(phone, message);
                    await logMessage(`${serverConfig.name} expires in ~30 minutes - warning sent`, 'BIOAUTH');
                } else if (remainingMinutes > 0 && remainingMinutes <= fiveMinuteWarningThreshold) {
                    const message = `🔴 *${serverConfig.name}* akan expired dalam ~5 menit!\n\n` +
                        `IP: ${serverConfig.ip}\n` +
                        `Sisa waktu: ${formattedRemainingTime}\n\n` +
                        (data.auth && data.auth.url ? `Link Re-authentication:\n${data.auth.url}` : 'Link otentikasi tidak tersedia.');
                    await sendWhatsAppMessage(phone, message);
                    await logMessage(`${serverConfig.name} expires in ~5 minutes - URGENT warning sent`, 'BIOAUTH');
                }
            }
            return; // Exit after handling Active status
        }

        // Fallback for any other unhandled data.status.result values
        await logMessage(`Unhandled API response status for ${serverConfig.name}: ${JSON.stringify(data.status.result)}. Data: ${JSON.stringify(data)}`, 'WARN');

    } catch (error) {
        // Handle network/connection errors when trying to reach the server's /cek endpoint
        if (error.isAxiosError && (!error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')) {
            await logMessage(`Connection error for ${serverConfig.name} (${serverConfig.ip}:${serverConfig.port}): ${error.message}. Server endpoint might be down or unreachable.`, 'ERROR');
            // Optionally, send a generic "server unreachable" notification if desired,
            // as this is different from the API reporting "ServerDown".
            // Example:
            // const unreachableMessage = `🔌 *${serverConfig.name}* tidak dapat dihubungi!\n\n` +
            //                          `IP: ${serverConfig.ip}:${serverConfig.port}\n` +
            //                          `Error: ${error.message}\n\n` +
            //                          `Mohon periksa apakah server dan layanan API helper berjalan.`;
            // await sendWhatsAppMessage(phone, unreachableMessage);
            // await logMessage(`${serverConfig.name} is UNREACHABLE - notification sent`, 'BIOAUTH');
        } else {
            // Other unexpected errors during checkBioauth
            await logMessage(`Unexpected error in checkBioauth for ${serverConfig.name}: ${error.message} (Stack: ${error.stack})`, 'ERROR');
        }
    }
}

// WhatsApp message sending function
async function sendWhatsAppMessage(phone, message) {
    try {
        await logMessage(`Sending message to ${phone}`, 'WHATSAPP');
        const chatId = `${phone}@c.us`; // Standard format for WhatsApp user IDs
        await client.sendMessage(chatId, message);
        await logMessage(`Message sent to ${phone}`, 'SUCCESS');
    } catch (error) {
        await logMessage(`Failed to send message to ${phone}: ${error.message}`, 'ERROR');
    }
}

// Bioauth checker runner
async function startBioauthChecker() {
    if (isBioauthChecking) {
        await logMessage('Skip: check already in progress', 'BIOAUTH');
        return;
    }

    try {
        isBioauthChecking = true;
        await logMessage('Starting check cycle...', 'BIOAUTH');
        const allowlist = await loadAllowlist(); // Load the latest allowlist

        if (Object.keys(allowlist).length === 0) {
            await logMessage('Allowlist is empty. No servers to check.', 'WARN');
            isBioauthChecking = false; // Release lock
            return;
        }

        for (const [phone, serverConfig] of Object.entries(allowlist)) {
            // Validate serverConfig to prevent errors
            if (!serverConfig || !serverConfig.ip || !serverConfig.port || !serverConfig.name) {
                await logMessage(`Skipping invalid server configuration for phone ${phone}: ${JSON.stringify(serverConfig)}`, 'WARN');
                continue;
            }
            await checkBioauth(phone, serverConfig); // Pass the serverConfig which includes its current status
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay between checks
        }
    } catch (error) {
        await logMessage(`Checker error: ${error.message}`, 'ERROR');
    } finally {
        isBioauthChecking = false;
        await logMessage('Check cycle completed', 'BIOAUTH');
    }
}

// Initialize balance monitor
const balanceMonitor = new HumanodeBalanceMonitor();

// Ensure necessary directories exist
async function ensureDirectories() {
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.mkdir(LOG_DIR, { recursive: true });
        await fs.mkdir(AUTH_DIR, { recursive: true }); // For WhatsApp session data
        await logMessage('Required directories ensured.', 'SYSTEM');

        // Create an empty allowlist if it doesn't exist, with a default structure example
        try {
            await fs.access(ALLOWLIST_PATH);
        } catch (e) {
            // Example structure for a new allowlist.json
            const exampleAllowlist = {
                /*
                  "628xxxxxxxxxx": {
                      "ip": "YOUR_SERVER_IP",
                      "port": "YOUR_HELPER_API_PORT",
                      "name": "YourServerName",
                      "address": "YourHumanodeAddress (optional, for balance monitoring)",
                      "status": "active" // Default status
                  }
                */
            };
            await fs.writeFile(ALLOWLIST_PATH, JSON.stringify(exampleAllowlist, null, 2), 'utf8');
            await logMessage(`Created empty/example allowlist at ${ALLOWLIST_PATH}. Please configure it.`, 'SYSTEM');
        }

    } catch (error) {
        console.error(chalk.red(`FATAL: Could not create necessary directories: ${error.message}`));
        process.exit(1); // Exit if directories can't be created
    }
}


// WhatsApp event handlers
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    logMessage('QR Code generated. Please scan with WhatsApp', 'WHATSAPP');
});

client.on('ready', async () => {
    await logMessage('Client is ready', 'WHATSAPP');

    // Start bioauth checker with interval
    startBioauthChecker(); // Initial check
    setInterval(startBioauthChecker, BIOAUTH_INTERVAL);

    // Start balance monitoring for each address
    const allowlist = await loadAllowlist();
    if (Object.keys(allowlist).length > 0) {
        for (const [phone, serverConfig] of Object.entries(allowlist)) {
            if (serverConfig && serverConfig.address && serverConfig.address !== 'Tidak diset') {
                balanceMonitor.startMonitoring(phone, serverConfig)
                    .catch(async (error) => { // Catch errors during individual monitor startup
                        await logMessage(`Failed to start monitoring for ${serverConfig.name}: ${error.message}`, 'ERROR');
                    });
            }
        }
    } else {
        await logMessage('No servers in allowlist to monitor balances for.', 'BALANCE');
    }
    await logMessage('System initialized - All monitors running (if configured)', 'SUCCESS');
});

client.on('authenticated', () => {
    logMessage('Client authenticated', 'WHATSAPP');
});

client.on('auth_failure', (error) => {
    logMessage(`Authentication failed: ${error.message}`, 'ERROR');
    // Consider exiting or attempting re-authentication if this occurs
});

client.on('disconnected', (reason) => {
    logMessage(`WhatsApp client disconnected: ${reason}. Attempting to re-initialize...`, 'WARN');
    client.initialize().catch(async initError => { // Attempt to re-initialize
        await logMessage(`Re-initialization error after disconnect: ${initError.message}`, 'ERROR');
        // Consider a more robust reconnection strategy if this fails often
    });
});


// Main function to start the application
async function main() {
    await ensureDirectories(); // Ensure directories are set up before anything else
    logMessage('Initializing monitoring system...', 'SYSTEM');

    try {
        await client.initialize();
    } catch (error) {
        await logMessage(`WhatsApp client initialization error: ${error.message}`, 'ERROR');
        process.exit(1); // Exit if WhatsApp client fails to initialize
    }
}

// Start the application
main();


// Handle process termination
async function gracefulShutdown(signal) {
    await logMessage(`Received ${signal}. Shutting down gracefully...`, 'SYSTEM');
    isBioauthChecking = true; // Prevent new checks from starting during shutdown

    if (balanceMonitor) {
        try {
            await balanceMonitor.disconnect();
            await logMessage('Balance monitor disconnected.', 'SYSTEM');
        } catch (e) {
            await logMessage(`Error disconnecting balance monitor: ${e.message}`, 'ERROR');
        }
    }

    // Clear the interval for bioauth checker
    if (typeof BIOAUTH_INTERVAL_ID !== 'undefined') { // Assuming you store interval ID
        clearInterval(BIOAUTH_INTERVAL_ID);
        await logMessage('Bioauth checker interval cleared.', 'SYSTEM');
    }


    if (client) {
        try {
            await client.destroy();
            await logMessage('WhatsApp client destroyed.', 'SYSTEM');
        } catch (e) {
            await logMessage(`Error destroying WhatsApp client: ${e.message}`, 'ERROR');
        }
    }
    process.exit(0);
}

// Store interval ID for graceful shutdown
let BIOAUTH_INTERVAL_ID;

// Modify client.on('ready') to store interval ID
client.on('ready', async () => {
    await logMessage('Client is ready', 'WHATSAPP');

    startBioauthChecker(); // Initial check
    BIOAUTH_INTERVAL_ID = setInterval(startBioauthChecker, BIOAUTH_INTERVAL); // Store the interval ID

    // ... rest of the ready handler
    const allowlist = await loadAllowlist();
    if (Object.keys(allowlist).length > 0) {
        for (const [phone, serverConfig] of Object.entries(allowlist)) {
            if (serverConfig && serverConfig.address && serverConfig.address !== 'Tidak diset') {
                balanceMonitor.startMonitoring(phone, serverConfig)
                    .catch(async (error) => {
                        await logMessage(`Failed to start monitoring for ${serverConfig.name}: ${error.message}`, 'ERROR');
                    });
            }
        }
    } else {
        await logMessage('No servers in allowlist to monitor balances for.', 'BALANCE');
    }
    await logMessage('System initialized - All monitors running (if configured)', 'SUCCESS');
});


process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
