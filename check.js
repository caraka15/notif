const { ApiPromise, WsProvider } = require('@polkadot/api');

class HumanodeBalanceMonitor {
    constructor() {
        this.wsEndpoint = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io';
        this.api = null;
        this.lastBalance = null;
        this.isMonitoring = false;
    }

    async connect() {
        try {
            const provider = new WsProvider(this.wsEndpoint);
            this.api = await ApiPromise.create({
                provider,
                ss58Format: 5234
            });

            console.log('\nTerhubung ke Humanode Network');
            console.log('Memulai monitoring saldo...\n');

            return true;
        } catch (error) {
            console.error('Error koneksi:', error);
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
            console.error('Error mengecek balance:', error.message);
            throw error;
        }
    }

    formatBalance(balance) {
        // Mengkonversi balance ke format yang lebih mudah dibaca
        const balanceNum = Number(balance) / 1_000_000_000_000; // 12 decimals untuk EHMT
        return balanceNum.toFixed(4);
    }

    async startMonitoring(address) {
        try {
            if (!this.api) {
                await this.connect();
            }

            this.isMonitoring = true;

            // Simpan balance awal
            const initialBalance = await this.getBalance(address);
            this.lastBalance = initialBalance.free;

            // Monitor balance setiap 5 menit
            const monitoringInterval = setInterval(async () => {
                if (!this.isMonitoring) {
                    clearInterval(monitoringInterval);
                    return;
                }

                try {
                    const currentBalance = await this.getBalance(address);
                    const newBalance = currentBalance.free;

                    const lastBalanceBig = BigInt(this.lastBalance);
                    const newBalanceBig = BigInt(newBalance);

                    if (newBalanceBig > lastBalanceBig) {
                        const difference = newBalanceBig - lastBalanceBig;
                        console.log(`Saldo anda masuk ${this.formatBalance(difference.toString())} EHMT`);
                    }

                    this.lastBalance = newBalance;
                } catch (error) {
                    console.error('Error:', error.message);
                }
            }, 5 * 60 * 1000); // 5 menit

            // Monitor events secara real-time
            await this.api.query.system.account(address, async (accountInfo) => {
                const currentBalance = accountInfo.data.free.toString();

                if (this.lastBalance && BigInt(currentBalance) > BigInt(this.lastBalance)) {
                    const difference = BigInt(currentBalance) - BigInt(this.lastBalance);
                    console.log(`Saldo anda masuk ${this.formatBalance(difference.toString())} EHMT`);
                }

                this.lastBalance = currentBalance;
            });

        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        }
    }

    async disconnect() {
        if (this.api) {
            this.isMonitoring = false;
            await this.api.disconnect();
            console.log('\nMonitoring dihentikan');
        }
    }
}

// Jika file dijalankan langsung
if (require.main === module) {
    const address = process.argv[2];

    if (!address) {
        console.error('\nError: Alamat tidak diberikan');
        console.log('Penggunaan: node index.js <alamat>');
        process.exit(1);
    }

    const monitor = new HumanodeBalanceMonitor();

    // Handle CTRL+C
    process.on('SIGINT', async () => {
        await monitor.disconnect();
        process.exit(0);
    });

    // Mulai monitoring
    monitor.startMonitoring(address).catch(async (error) => {
        console.error('Error:', error);
        await monitor.disconnect();
        process.exit(1);
    });
}

module.exports = HumanodeBalanceMonitor;