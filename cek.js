const { ApiRx, WsProvider } = require('@polkadot/api');
const { firstValueFrom } = require('rxjs');
const { encodeAddress } = require('@polkadot/util-crypto');

class HumanodeValidatorMonitor {
    constructor(endpoint = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io') {
        this.endpoint = endpoint;
        this.api = null;
        this.ss58Format = 5234; // Format alamat SS58 untuk Humanode
    }

    async connect() {
        if (this.api && this.api.isConnected) {
            console.log('Sudah terhubung ke node Humanode.');
            return;
        }
        console.log('Menghubungkan ke node Humanode...');
        this.api = await ApiRx.create({ provider: new WsProvider(this.endpoint) }).toPromise();
        console.log('Berhasil terhubung.');
    }

    async disconnect() {
        if (this.api) {
            await this.api.disconnect();
            console.log('Koneksi ke node Humanode diputus.');
            this.api = null;
        }
    }

    async getEpochDurationInBlocks() {
        if (!this.api || !this.api.isConnected) await this.connect();
        return this.api.consts.babe.epochDuration.toNumber();
    }

    async getCurrentNetworkEpoch() {
        if (!this.api || !this.api.isConnected) await this.connect();
        const sessionInfo = await firstValueFrom(this.api.query.session.currentIndex());
        return sessionInfo.toNumber();
    }

    async getValidatorsAtBlock(blockNumber) {
        if (!this.api || !this.api.isConnected) await this.connect();
        // Pastikan blockNumber adalah angka yang valid dan positif
        if (typeof blockNumber !== 'number' || blockNumber < 0) {
            throw new Error(`Nomor blok tidak valid: ${blockNumber}`);
        }
        const blockHash = await firstValueFrom(this.api.rpc.chain.getBlockHash(blockNumber));
        if (!blockHash || blockHash.isEmpty) {
            throw new Error(`Tidak dapat menemukan hash untuk blok #${blockNumber}`);
        }
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

    async getBlockTimestamp(blockNumber) {
        if (!this.api || !this.api.isConnected) await this.connect();
        if (typeof blockNumber !== 'number' || blockNumber < 0) {
            console.warn(`Timestamp tidak bisa diambil: Nomor blok tidak valid: ${blockNumber}`);
            return null;
        }
        const blockHash = await firstValueFrom(this.api.rpc.chain.getBlockHash(blockNumber));
        if (!blockHash || blockHash.isEmpty) {
            console.warn(`Timestamp tidak bisa diambil: Hash blok tidak ditemukan untuk blok #${blockNumber}`);
            return null;
        }
        const apiAt = await this.api.at(blockHash);
        const timestamp = await firstValueFrom(apiAt.query.timestamp.now());
        return new Date(timestamp.toNumber());
    }

    /**
     * Memantau aktivitas validator untuk satu frasa hadiah penuh (84 epoch) yang ditentukan.
     * Hanya memproses epoch hingga epoch jaringan saat ini.
     * Jika validator tidak aktif pada pengecekan awal, akan dilakukan pengecekan ulang 10 blok setelahnya.
     * @param {string} address Alamat validator yang akan dipantau.
     * @param {number} targetPhraseStartEpoch Epoch awal dari frasa yang ingin dipantau.
     */
    async monitorValidatorForPhrase(address, targetPhraseStartEpoch) {
        await this.connect();
        const formattedAddr = this.formatAddress(address);
        const monitoringResults = [];
        const PHRASE_LENGTH_IN_EPOCHS = 84;
        const RECHECK_OFFSET_BLOCKS = 10; // Jumlah blok untuk pengecekan ulang

        try {
            const singleEpochDurationInBlocks = await this.getEpochDurationInBlocks();
            const currentNetworkEpoch = await this.getCurrentNetworkEpoch();
            const currentHeader = await firstValueFrom(this.api.rpc.chain.getHeader());
            const currentNetworkBlockNumber = currentHeader.number.toNumber();

            const targetPhraseEndEpoch = targetPhraseStartEpoch + PHRASE_LENGTH_IN_EPOCHS - 1;

            console.log(`\n🔍 Memulai Pemantauan Validator untuk Frasa Hadiah`);
            console.log(`----------------------------------------------------`);
            console.log(`Alamat Validator  : ${formattedAddr}`);
            console.log(`Frasa Target      : Epoch ${targetPhraseStartEpoch} - ${targetPhraseEndEpoch}`);
            console.log(`Epoch Saat Ini    : ${currentNetworkEpoch}`);
            console.log(`Blok Saat Ini     : ${currentNetworkBlockNumber}`);
            console.log(`Durasi per Epoch  : ${singleEpochDurationInBlocks} blok`);
            console.log(`Pengecekan Ulang  : ${RECHECK_OFFSET_BLOCKS} blok setelah non-aktif`);
            console.log(`----------------------------------------------------`);

            if (targetPhraseStartEpoch > currentNetworkEpoch) {
                console.warn(`\n⚠️ PERINGATAN: Frasa target (dimulai dari epoch ${targetPhraseStartEpoch}) belum dimulai. Epoch jaringan saat ini adalah ${currentNetworkEpoch}.`);
                return { validator: formattedAddr, targetPhraseStartEpoch, targetPhraseEndEpoch, currentEpochOnNetwork: currentNetworkEpoch, monitoringResults: [] };
            }

            for (let i = 0; i < PHRASE_LENGTH_IN_EPOCHS; i++) {
                const epochToMonitor = targetPhraseStartEpoch + i;
                const epochCheckResults = []; // Hasil untuk semua pengecekan (awal dan ulang) di epoch ini
                let epochStatusSummary = 'BELUM DIPROSES';

                if (epochToMonitor > currentNetworkEpoch) {
                    console.log(`\n⏭️  Epoch ${epochToMonitor} (dalam frasa target) belum tercapai. Pemantauan untuk frasa ini berhenti pada epoch sebelumnya.`);
                    break;
                }

                console.log(`\n📅 Memproses Epoch ${epochToMonitor}`);

                const startBlockOfCurrentNetworkEpoch = currentNetworkBlockNumber - (currentNetworkBlockNumber % singleEpochDurationInBlocks);
                const epochsDifferenceFromCurrent = currentNetworkEpoch - epochToMonitor;
                const firstBlockOfEpochToMonitor = startBlockOfCurrentNetworkEpoch - (epochsDifferenceFromCurrent * singleEpochDurationInBlocks);

                if (firstBlockOfEpochToMonitor < 1) {
                    console.warn(`   ⚠️ Peringatan: Perkiraan blok awal untuk epoch ${epochToMonitor} adalah <= 0 (${firstBlockOfEpochToMonitor}). Melewati epoch ini.`);
                    monitoringResults.push({ epoch: epochToMonitor, status: 'ERROR_BLOK_AWAL_TIDAK_VALID', checks: [{ blockNumber: firstBlockOfEpochToMonitor, error: "Perkiraan blok awal tidak valid.", type: 'error' }] });
                    continue;
                }

                const checkPointsInEpoch_Theoretical = [
                    firstBlockOfEpochToMonitor + Math.floor(singleEpochDurationInBlocks * 0.25),
                    firstBlockOfEpochToMonitor + Math.floor(singleEpochDurationInBlocks * 0.50),
                    firstBlockOfEpochToMonitor + Math.floor(singleEpochDurationInBlocks * 0.75),
                    firstBlockOfEpochToMonitor + singleEpochDurationInBlocks - 1,
                ];

                const checkableInitialBlocks = [...new Set(checkPointsInEpoch_Theoretical)].filter(blockNum => blockNum > 0 && blockNum <= currentNetworkBlockNumber).sort((a, b) => a - b);

                console.log(`   Blok awal teoritis: ${firstBlockOfEpochToMonitor}. Titik pengecekan teoritis: ${checkPointsInEpoch_Theoretical.join(', ')}`);
                if (checkableInitialBlocks.length > 0) {
                    console.log(`   Titik pengecekan awal yang akan divalidasi (blok sudah terjadi): ${checkableInitialBlocks.join(', ')}`);
                } else {
                    console.log(`   Tidak ada titik pengecekan awal yang sudah terjadi untuk epoch ${epochToMonitor}.`);
                }

                for (const initialBlockNumber of checkableInitialBlocks) {
                    let isActiveAtInitialCheck = false;
                    let initialCheckError = null;
                    let initialCheckTimestamp = 'N/A';

                    try {
                        const validatorsAtInitialBlock = await this.getValidatorsAtBlock(initialBlockNumber);
                        isActiveAtInitialCheck = validatorsAtInitialBlock.includes(formattedAddr);
                        const ts = await this.getBlockTimestamp(initialBlockNumber);
                        initialCheckTimestamp = ts ? ts.toISOString() : 'N/A';

                        epochCheckResults.push({
                            blockNumber: initialBlockNumber,
                            active: isActiveAtInitialCheck,
                            timestamp: initialCheckTimestamp,
                            type: 'initial'
                        });
                        await new Promise(resolve => setTimeout(resolve, 200)); // Jeda setelah pengecekan awal

                        if (!isActiveAtInitialCheck) { // Jika tidak aktif, lakukan pengecekan ulang
                            console.log(`   -> Validator NON-AKTIF pada blok #${initialBlockNumber}. Mencoba pengecekan ulang...`);
                            const reCheckBlockNumber = initialBlockNumber + RECHECK_OFFSET_BLOCKS;

                            if (reCheckBlockNumber <= currentNetworkBlockNumber) {
                                try {
                                    await new Promise(resolve => setTimeout(resolve, 200)); // Jeda sebelum re-check
                                    const validatorsAtReCheck = await this.getValidatorsAtBlock(reCheckBlockNumber);
                                    const isActiveAtReCheck = validatorsAtReCheck.includes(formattedAddr);
                                    const timestampAtReCheck = await this.getBlockTimestamp(reCheckBlockNumber);

                                    epochCheckResults.push({
                                        blockNumber: reCheckBlockNumber,
                                        active: isActiveAtReCheck,
                                        timestamp: timestampAtReCheck ? timestampAtReCheck.toISOString() : 'N/A',
                                        type: 're-check',
                                        originalCheckBlock: initialBlockNumber
                                    });
                                    console.log(`      Pengecekan ulang pada blok #${reCheckBlockNumber}: ${isActiveAtReCheck ? 'AKTIF' : 'NON-AKTIF'}`);
                                } catch (reCheckError) {
                                    console.error(`      🔴 Error saat pengecekan ulang blok #${reCheckBlockNumber}: ${reCheckError.message}`);
                                    epochCheckResults.push({
                                        blockNumber: reCheckBlockNumber, error: reCheckError.message, timestamp: 'N/A', active: 'Error', type: 're-check', originalCheckBlock: initialBlockNumber
                                    });
                                }
                            } else {
                                console.log(`      Pengecekan ulang pada blok #${reCheckBlockNumber} dilewati (blok belum terjadi).`);
                                epochCheckResults.push({
                                    blockNumber: reCheckBlockNumber, error: 'Blok pengecekan ulang belum terjadi', type: 're-check-skipped', originalCheckBlock: initialBlockNumber
                                });
                            }
                        }
                    } catch (error) { // Error pada pengecekan awal
                        console.error(`   🔴 Error saat memeriksa blok awal #${initialBlockNumber} di epoch ${epochToMonitor}: ${error.message}`);
                        initialCheckError = error.message;
                        epochCheckResults.push({
                            blockNumber: initialBlockNumber, error: initialCheckError, timestamp: 'N/A', active: 'Error', type: 'initial'
                        });
                    }
                }

                // Tentukan status epoch "PASS" atau lainnya
                let passedCheckpointsForEpoch = 0;
                let totalErroredChecksInEpoch = 0;

                for (const initialBlockNum of checkableInitialBlocks) {
                    const initialCheck = epochCheckResults.find(c => c.blockNumber === initialBlockNum && c.type === 'initial');
                    let checkpointConsideredActive = false;
                    let checkpointHadError = false;

                    if (initialCheck) {
                        if (initialCheck.error) {
                            checkpointHadError = true;
                        } else if (initialCheck.active) {
                            checkpointConsideredActive = true;
                        } else { // Initial check non-aktif, cari re-check
                            const reCheck = epochCheckResults.find(rc => rc.originalCheckBlock === initialBlockNum && rc.type === 're-check');
                            if (reCheck) {
                                if (reCheck.error) {
                                    checkpointHadError = true;
                                } else if (reCheck.active) {
                                    checkpointConsideredActive = true;
                                }
                            } else {
                                // Jika tidak ada re-check (misalnya karena re-check-skipped atau logic error), anggap non-aktif
                            }
                        }
                    } else { // Seharusnya tidak terjadi jika checkableInitialBlocks benar
                        checkpointHadError = true;
                    }

                    if (checkpointConsideredActive) {
                        passedCheckpointsForEpoch++;
                    }
                    if (checkpointHadError) {
                        totalErroredChecksInEpoch++;
                    }
                }

                const expectedPastCheckpointsCount = checkableInitialBlocks.length;

                if (firstBlockOfEpochToMonitor < 1) {
                    epochStatusSummary = 'ERROR_BLOK_AWAL_TIDAK_VALID';
                } else if (expectedPastCheckpointsCount === 0 && epochToMonitor < currentNetworkEpoch) {
                    epochStatusSummary = 'TIDAK ADA BLOK VALID UNTUK DICEK (EPOCH LALU)';
                } else if (expectedPastCheckpointsCount === 4) { // Epoch seharusnya sudah selesai
                    if (passedCheckpointsForEpoch === 4 && totalErroredChecksInEpoch === 0) {
                        epochStatusSummary = 'PASS';
                    } else {
                        epochStatusSummary = `FAIL (${passedCheckpointsForEpoch}/4 AKTIF, ${totalErroredChecksInEpoch} error)`;
                    }
                } else if (epochToMonitor === currentNetworkEpoch) { // Epoch sedang berjalan
                    if (expectedPastCheckpointsCount > 0) {
                        if (passedCheckpointsForEpoch === expectedPastCheckpointsCount && totalErroredChecksInEpoch === 0) {
                            epochStatusSummary = `AKTIF SEJAUH INI (${passedCheckpointsForEpoch}/${expectedPastCheckpointsCount})`;
                        } else {
                            epochStatusSummary = `BEBERAPA CEK NON-AKTIF/ERROR (${passedCheckpointsForEpoch}/${expectedPastCheckpointsCount} AKTIF, ${totalErroredChecksInEpoch} error)`;
                        }
                    } else {
                        epochStatusSummary = 'EPOCH BARU SAJA DIMULAI (Belum ada checkpoint terlewati)';
                    }
                } else { // Epoch lalu, tapi kurang dari 4 checkpoint terlewati
                    if (expectedPastCheckpointsCount > 0) {
                        if (passedCheckpointsForEpoch === expectedPastCheckpointsCount && totalErroredChecksInEpoch === 0) {
                            epochStatusSummary = `PASS (${passedCheckpointsForEpoch}/${expectedPastCheckpointsCount})`;
                        } else {
                            epochStatusSummary = `FAIL/DATA TIDAK LENGKAP (${passedCheckpointsForEpoch}/${expectedPastCheckpointsCount} AKTIF, ${totalErroredChecksInEpoch} error)`;
                        }
                    } else {
                        epochStatusSummary = 'TIDAK CUKUP DATA HISTORIS (<4 checkpoint terlewati)';
                    }
                }
                monitoringResults.push({ epoch: epochToMonitor, status: epochStatusSummary, checks: epochCheckResults });
            }

            return {
                validator: formattedAddr,
                targetPhraseStartEpoch,
                targetPhraseEndEpoch,
                currentEpochOnNetwork: currentNetworkEpoch,
                monitoringResults
            };

        } catch (error) {
            console.error(`🔴 Terjadi error besar selama pemantauan frasa: ${error.message}`);
            // Mengembalikan struktur yang konsisten jika terjadi error besar
            const currentEpoch = await this.getCurrentNetworkEpoch().catch(() => 'N/A');
            return { validator: formattedAddr, targetPhraseStartEpoch, targetPhraseEndEpoch, currentEpochOnNetwork: currentEpoch, monitoringResults: [{ epoch: 'Error Global', status: 'ERROR', checks: [{ error: error.message, type: 'error' }] }] };
        } finally {
            await this.disconnect();
        }
    }
}

// Contoh penggunaan
(async () => {
    const monitor = new HumanodeValidatorMonitor();
    const addressToMonitor = 'hmpsvuEucaxX69U6kndznmJ1teXwqe3hAcyfUmPFaHgd7rmCt'; // GANTI DENGAN ALAMAT VALIDATOR ANDA

    const phraseStartEpochForMonitoring = 5449;
    // const phraseStartEpochForMonitoring = 5366; // Contoh: memantau frasa sebelumnya

    try {
        const result = await monitor.monitorValidatorForPhrase(addressToMonitor, phraseStartEpochForMonitoring);

        if (!result || !result.monitoringResults || result.monitoringResults.length === 0) {
            console.log(`\n🏁 Tidak ada hasil pemantauan yang dapat ditampilkan untuk frasa yang dimulai dari epoch ${phraseStartEpochForMonitoring}.`);
            // ... (logika output jika tidak ada hasil) ...
        } else {
            console.log(`\n\n✅ HASIL PEMANTAUAN UNTUK VALIDATOR: ${result.validator}`);
            console.log(`================================================================`);
            console.log(`Frasa yang Dipantau      : Epoch ${result.targetPhraseStartEpoch} - ${result.targetPhraseEndEpoch}`);
            console.log(`Epoch Jaringan Saat Ini  : ${result.currentEpochOnNetwork}`);
            console.log(`================================================================`);

            result.monitoringResults.forEach(epochData => {
                console.log(`\n📅 EPOCH ${epochData.epoch} | STATUS KESELURUHAN: ${epochData.status}`);
                console.log(`---------------------------------------------------`);

                if (epochData.checks && epochData.checks.length > 0) {
                    // Kelompokkan hasil pengecekan berdasarkan blok pengecekan awal
                    const initialCheckBlocksProcessed = new Set();
                    epochData.checks.filter(c => c.type === 'initial' || c.type === 'error' && !c.originalCheckBlock).forEach((initialCheck, idx) => {
                        if (!initialCheck.blockNumber || initialCheckBlocksProcessed.has(initialCheck.blockNumber)) return; // Hindari duplikasi jika ada error sebelum tipe diset
                        initialCheckBlocksProcessed.add(initialCheck.blockNumber);

                        let statusDetail = '❓';
                        if (initialCheck.error) {
                            statusDetail = `⚠️  ERROR: ${initialCheck.error}`;
                        } else if (typeof initialCheck.active === 'boolean') {
                            statusDetail = initialCheck.active ? '✅ AKTIF' : '❌ NON-AKTIF';
                        }
                        console.log(`  [Pengecekan Awal ${String(idx + 1).padStart(2)}] Blok #${String(initialCheck.blockNumber || 'N/A').padEnd(10)} | ⏱️  ${String(initialCheck.timestamp || 'N/A').padEnd(24)} | Status: ${statusDetail}`);

                        // Cari dan tampilkan hasil re-check jika ada
                        const reCheckForThis = epochData.checks.find(rc => rc.originalCheckBlock === initialCheck.blockNumber && (rc.type === 're-check' || rc.type === 're-check-skipped'));
                        if (reCheckForThis) {
                            let reCheckStatusDetail = '❓';
                            if (reCheckForThis.error) {
                                reCheckStatusDetail = (reCheckForThis.type === 're-check-skipped') ? `⏭️  DILEWATI: ${reCheckForThis.error}` : `⚠️  ERROR: ${reCheckForThis.error}`;
                            } else if (typeof reCheckForThis.active === 'boolean') {
                                reCheckStatusDetail = reCheckForThis.active ? '✅ AKTIF (setelah re-check)' : '❌ NON-AKTIF (setelah re-check)';
                            }
                            console.log(`    [Pengecekan Ulang   ] Blok #${String(reCheckForThis.blockNumber || 'N/A').padEnd(10)} | ⏱️  ${String(reCheckForThis.timestamp || 'N/A').padEnd(24)} | Status: ${reCheckStatusDetail}`);
                        }
                    });
                } else {
                    console.log(`   Tidak ada data pengecekan detail untuk epoch ini (Status: ${epochData.status}).`);
                }
            });
            console.log(`\n🏁 Pemantauan selesai.`);
        }

    } catch (error) {
        console.error('🔴 Error utama pada skrip pemantauan:', error.message);
        if (error.stack) {
            // console.error(error.stack); 
        }
    }
})();
