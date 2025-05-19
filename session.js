const { ApiRx, WsProvider } = require('@polkadot/api');
const { firstValueFrom } = require('rxjs');
const { encodeAddress } = require('@polkadot/util-crypto');

class HumanodeValidatorMonitor {
  constructor(endpoint = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io') {
    this.endpoint = endpoint;
    this.api = null;
    this.ss58Format = 5234;
    this.checksPerEpoch = 4; // 4x pengecekan per epoch
  }

  async connect() {
    this.api = await ApiRx.create({ provider: new WsProvider(this.endpoint) }).toPromise();
  }

  async disconnect() {
    if (this.api) await this.api.disconnect();
  }

  async getEpochDuration() {
    return this.api.consts.babe.epochDuration.toNumber();
  }

  async getCurrentEpoch() {
    return (await firstValueFrom(this.api.query.humanodeSession.currentSessionIndex()));
  }

  async getValidatorsAtBlock(blockNumber) {
    const blockHash = await firstValueFrom(this.api.rpc.chain.getBlockHash(blockNumber));
    const apiAt = await this.api.at(blockHash);
    const validators = await firstValueFrom(apiAt.query.session.validators());
    return validators.map(v => this.formatAddress(v.toString()));
  }

  formatAddress(address) {
    try {
      return encodeAddress(address, this.ss58Format);
    } catch {
      return address;
    }
  }

  async monitorValidator(address, epochsToMonitor = 5) {
    await this.connect();
    const formattedAddr = this.formatAddress(address);
    const results = [];

    try {
      const epochDuration = await this.getEpochDuration();
      const currentEpoch = await this.getCurrentEpoch();
      const currentHeader = await firstValueFrom(this.api.rpc.chain.getHeader());
      const currentBlock = currentHeader.number.toNumber();

      for (let epochOffset = 0; epochOffset < epochsToMonitor; epochOffset++) {
        const epoch = currentEpoch - epochOffset;
        const epochStartBlock = currentBlock - (epochOffset * epochDuration);

        // Tentukan 4 titik pengecekan dalam 1 epoch
        const checkPoints = [
          epochStartBlock + Math.floor(epochDuration * 0.25),
          epochStartBlock + Math.floor(epochDuration * 0.5),
          epochStartBlock + Math.floor(epochDuration * 0.75),
          epochStartBlock + epochDuration - 1 // Block terakhir epoch
        ];

        const epochResults = [];
        for (const blockNumber of checkPoints) {
          try {
            const validators = await this.getValidatorsAtBlock(blockNumber);
            epochResults.push({
              blockNumber,
              active: validators.includes(formattedAddr),
              timestamp: await this.getBlockTimestamp(blockNumber)
            });
          } catch (error) {
            epochResults.push({
              blockNumber,
              error: error.message
            });
          }
        }

        results.push({
          epoch,
          checks: epochResults
        });
      }

      return {
        validator: formattedAddr,
        currentEpoch,
        monitoringResults: results.reverse() // Urutkan dari oldest ke newest
      };

    } finally {
      await this.disconnect();
    }
  }

  async getBlockTimestamp(blockNumber) {
    const blockHash = await firstValueFrom(this.api.rpc.chain.getBlockHash(blockNumber));
    const apiAt = await this.api.at(blockHash);
    const timestamp = await firstValueFrom(apiAt.query.timestamp.now());
    return new Date(timestamp.toNumber());
  }
}

// Contoh penggunaan
(async () => {
  const monitor = new HumanodeValidatorMonitor();
  const address = 'hmpNTsugGbF6bAJiZ5fE2aBoiKAJS4Ktb62dArTxowfqqGNag';

  try {
    const result = await monitor.monitorValidator(address, 84); // Monitor 3 epoch terakhir

    console.log('\n🔍 Humanode Validator Activity Monitor');
    console.log('======================================');
    console.log(`Validator: ${result.validator}`);
    console.log(`Current Epoch: ${result.currentEpoch}\n`);

    result.monitoringResults.forEach(epochData => {
      console.log(`📅 Epoch ${epochData.epoch}`);
      console.log('----------------------------');

      epochData.checks.forEach((check, i) => {
        const timeStr = check.timestamp ? check.timestamp.toISOString() : 'N/A';
        const status = check.active ? '✅ AKTIF' :
          check.active === false ? '❌ NON-AKTIF' :
            `⚠️ ERROR: ${check.error}`;

        console.log(`[Check ${i + 1}] Block #${check.blockNumber}`);
        console.log(`⏱️  ${timeStr} | Status: ${status}\n`);
      });
    });

  } catch (error) {
    console.error('Monitoring error:', error);
  }
})();