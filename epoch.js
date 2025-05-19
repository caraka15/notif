const { ApiRx, WsProvider } = require('@polkadot/api');
const { firstValueFrom } = require('rxjs');

class EpochChecker {
  constructor(endpoint = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io') {
    this.endpoint = endpoint;
    this.api = null;
  }

  async connect() {
    this.api = await ApiRx.create({
      provider: new WsProvider(this.endpoint)
    }).toPromise();
    return this;
  }

  async disconnect() {
    if (this.api) {
      await this.api.disconnect();
    }
  }

  async getEpochProgress() {
    if (!this.api) {
      await this.connect();
    }

    try {
      const sessionInfo = await firstValueFrom(this.api.derive.session.progress());

      const total = sessionInfo.sessionLength.toNumber();
      const current = sessionInfo.sessionProgress.toNumber();
      const remainingBlocks = total - current;
      const percentage = (current / total) * 100;

      return {
        total,
        current,
        remainingBlocks,
        percentage: parseFloat(percentage.toFixed(2)), // 2 decimal places
        nextEpochIn: this.formatBlocksToTime(remainingBlocks),
        estimatedCompletion: this.estimateCompletionTime(remainingBlocks)
      };
    } catch (error) {
      console.error('⚠️ Error fetching epoch data:', error.message);
      return this.getDefaultEpochData();
    }
  }

  getDefaultEpochData() {
    return {
      total: 0,
      current: 0,
      remainingBlocks: 0,
      percentage: 0,
      nextEpochIn: 'N/A',
      estimatedCompletion: 'N/A'
    };
  }

  formatBlocksToTime(blocks) {
    // Asumsi 1 blok = 6 detik (sesuaikan dengan Humanode)
    const seconds = blocks * 6;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  estimateCompletionTime(blocks) {
    const seconds = blocks * 6;
    const completionDate = new Date(Date.now() + seconds * 1000);
    return completionDate.toLocaleString();
  }

  async printProgress() {
    const progress = await this.getEpochProgress();

    console.log('\n🔄 Humanode Epoch Progress');
    console.log('=========================');
    console.log(`🏗️  Blocks: ${progress.current}/${progress.total}`);
    console.log(`⏳ Remaining: ${progress.remainingBlocks} blocks`);
    console.log(`📈 Progress: ${progress.percentage}%`);
    console.log(`⏱️  Next epoch in: ${progress.nextEpochIn}`);
    console.log(`🕒 Estimated completion: ${progress.estimatedCompletion}`);
    console.log('=========================\n');

    return progress;
  }
}

// Contoh penggunaan
(async () => {
  const checker = new EpochChecker();

  try {
    await checker.connect();
    const progress = await checker.printProgress();

    // Anda bisa mengakses data lengkapnya:
    // console.log('Full progress data:', progress);
  } catch (error) {
    console.error('🔴 Error:', error.message);
  } finally {
    await checker.disconnect();
  }
})();