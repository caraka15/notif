// api_helper_monitor.js
const { ApiPromise, WsProvider } = require('@polkadot/api');
const fs = require('fs').promises;
const path = require('path');
// const axios = require('axios'); // Axios tidak lagi diperlukan
const chalk = require('chalk');

// --- Konfigurasi Path & Dasar ---
const ROOT_DIR = '/root/notif';
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist.json');
const LOG_FILE_PATH = path.join(ROOT_DIR, 'logs', 'api_helper_monitor.log');
const PHRASE_DATA_DIR = path.join(ROOT_DIR, 'api_helper_phrase_data');

const CHECK_INTERVAL_MS = 1 * 60 * 1000; // Diubah menjadi 1 menit
const EPOCH_CHECK_INTERVAL_MS = 60000; // Interval untuk memeriksa epoch jaringan & progressnya
const FIRST_EVER_PHRASE_START_EPOCH = 5450;
const PHRASE_DURATION_EPOCHS = 84;
const EPOCH_FAIL_THRESHOLD_SECONDS = 2 * 60 * 60;
const GLOBAL_RPC_ENDPOINT = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io';
const AVG_BLOCK_TIME_SECONDS = 6;

// --- Variabel State Global ---
let phraseMonitoringData = {};
let polkadotApi = null;
let lastKnownNetworkEpoch = -1;
let currentPhraseNumber = -1;
let currentPhraseStartEpochForMonitoring = -1;
let apiHelperCheckIntervalId = null; // Akan menjadi ID dari setInterval
let epochCheckIntervalId = null;
let currentEpochProgressDetails = {
    estimatedEpochCompletionTime: null,
    nextEpochETAFormatted: 'N/A',
    currentBlockInEpoch: 0,
    totalBlocksInEpoch: 0,
    percentage: 0
};

// --- Fungsi Utilitas ---
async function logMessage(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    let logString = `[${timestamp}] [${type}] ${message}`;
    let coloredMessage = logString;
    if (typeof chalk !== 'undefined') {
        switch (type) {
            case 'ERROR': coloredMessage = chalk.red(logString); break;
            case 'WARN': coloredMessage = chalk.yellow(logString); break;
            case 'SUCCESS': coloredMessage = chalk.green(logString); break;
            case 'PHRASE': coloredMessage = chalk.keyword('orange')(logString); break;
            case 'EPOCH': coloredMessage = chalk.keyword('purple')(logString); break;
            case 'API_HELPER': coloredMessage = chalk.blue(logString); break;
            case 'SYSTEM': coloredMessage = chalk.gray(logString); break;
            default: coloredMessage = chalk.white(logString);
        }
    }
    console.log(coloredMessage);
    try { await fs.appendFile(LOG_FILE_PATH, logString + '\n'); }
    catch (error) { console.error(`[${new Date().toISOString()}] [ERROR] Gagal menulis ke file log: ${error.message}`); }
}

async function loadAllowlist() {
    try {
        const data = await fs.readFile(ALLOWLIST_PATH, 'utf8');
        const allowlist = JSON.parse(data);
        await logMessage(`Berhasil memuat ${Object.keys(allowlist).length} entri dari allowlist.json`, 'SYSTEM');
        return allowlist;
    } catch (error) {
        await logMessage(`Error memuat allowlist dari ${ALLOWLIST_PATH}: ${error.message}. Skrip tidak dapat melanjutkan tanpa allowlist.`, 'ERROR');
        process.exit(1);
    }
}

async function savePhraseMonitoringData(phraseNumber, dataToSave) {
    if (typeof phraseNumber !== 'number' || phraseNumber < 1) {
        await logMessage(`Gagal menyimpan data frasa: nomor frasa tidak valid (${phraseNumber}).`, 'ERROR');
        return;
    }
    const filePath = path.join(PHRASE_DATA_DIR, `api_helper_phrase_${phraseNumber}_data.json`);
    try {
        const relevantDataForPhrase = {};
        for (const validatorKey in dataToSave) {
            if (dataToSave[validatorKey]?.[`phrase_${phraseNumber}`]) {
                if (!relevantDataForPhrase[validatorKey]) relevantDataForPhrase[validatorKey] = {};
                relevantDataForPhrase[validatorKey][`phrase_${phraseNumber}`] = dataToSave[validatorKey][`phrase_${phraseNumber}`];
            }
        }
        if (phraseNumber === currentPhraseNumber && currentEpochProgressDetails.estimatedEpochCompletionTime) {
            if (!relevantDataForPhrase.phraseMetadata) relevantDataForPhrase.phraseMetadata = {};
            relevantDataForPhrase.phraseMetadata.currentEpochProgress = { ...currentEpochProgressDetails, lastUpdated: new Date().toISOString() };
        }
        if (Object.keys(relevantDataForPhrase).length > 0) {
            await fs.writeFile(filePath, JSON.stringify(relevantDataForPhrase, null, 2));
            await logMessage(`Data pemantauan API helper frasa ${phraseNumber} disimpan.`, 'PHRASE');
        }
    } catch (error) {
        await logMessage(`Gagal menyimpan data pemantauan API helper frasa ${phraseNumber}: ${error.message}`, 'ERROR');
    }
}

async function loadPhraseMonitoringData(phraseNumber) {
    if (typeof phraseNumber !== 'number' || phraseNumber < 1) {
        await logMessage(`Gagal memuat data frasa: nomor frasa tidak valid (${phraseNumber}). Mengembalikan data kosong.`, 'WARN');
        return {};
    }
    const filePath = path.join(PHRASE_DATA_DIR, `api_helper_phrase_${phraseNumber}_data.json`);
    try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf8');
        await logMessage(`Memuat data pemantauan API helper yang ada untuk frasa ${phraseNumber}.`, 'PHRASE');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await logMessage(`Tidak ada data pemantauan API helper tersimpan untuk frasa ${phraseNumber}. Memulai data baru.`, 'PHRASE');
        } else {
            await logMessage(`Gagal memuat data pemantauan API helper untuk frasa ${phraseNumber}: ${error.message}. Memulai data baru.`, 'ERROR');
        }
        return {};
    }
}

async function initializeGlobalPolkadotApi() {
    if (polkadotApi && polkadotApi.isConnected) return polkadotApi;
    try {
        await logMessage('Menghubungkan ke API Polkadot global untuk info epoch...', 'SYSTEM');
        const provider = new WsProvider(GLOBAL_RPC_ENDPOINT);
        polkadotApi = await ApiPromise.create({ provider });
        await polkadotApi.isReady;
        await logMessage('Berhasil terhubung ke API Polkadot global.', 'SUCCESS');
        return polkadotApi;
    } catch (error) {
        await logMessage(`Gagal terhubung ke API Polkadot global: ${error.message}`, 'ERROR');
        if (polkadotApi) await polkadotApi.disconnect().catch(e => logMessage(`Error saat disconnect API global: ${e.message}`, true));
        polkadotApi = null;
        return null;
    }
}

async function getCurrentNetworkEpochFromPolkadotApi() {
    const api = await initializeGlobalPolkadotApi();
    if (!api) return -1;
    try {
        const currentIndex = await api.query.session.currentIndex();
        return currentIndex.toNumber();
    } catch (error) {
        await logMessage(`Gagal mendapatkan epoch jaringan saat ini dari API Polkadot: ${error.message}`, 'ERROR');
        return -1;
    }
}

function formatBlocksToTime(blocks, blockTimeSeconds = AVG_BLOCK_TIME_SECONDS) {
    if (typeof blocks !== 'number' || blocks < 0) return 'N/A';
    const totalSeconds = blocks * blockTimeSeconds;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours} jam ${minutes} menit`;
}

function estimateCompletionTimeMs(blocks, blockTimeSeconds = AVG_BLOCK_TIME_SECONDS) {
    if (typeof blocks !== 'number' || blocks < 0) return null;
    const totalSeconds = blocks * blockTimeSeconds;
    return Date.now() + totalSeconds * 1000;
}

async function updateCurrentEpochProgressDetails() {
    const api = await initializeGlobalPolkadotApi();
    if (!api) {
        await logMessage("API Polkadot Global tidak terinisialisasi, tidak dapat update progress epoch.", "WARN");
        currentEpochProgressDetails = { estimatedEpochCompletionTime: null, nextEpochETAFormatted: 'N/A', currentBlockInEpoch: 0, totalBlocksInEpoch: 0, percentage: 0, currentEpochIndexFromProgress: lastKnownNetworkEpoch };
        return;
    }
    try {
        const sessionInfo = await api.derive.session.progress();
        const totalBlocksInEpoch = sessionInfo.sessionLength.toNumber();
        const currentBlockInEpoch = sessionInfo.sessionProgress.toNumber();
        const remainingBlocks = totalBlocksInEpoch > 0 ? totalBlocksInEpoch - currentBlockInEpoch : 0;
        const percentage = totalBlocksInEpoch > 0 ? (currentBlockInEpoch / totalBlocksInEpoch) * 100 : 0;
        const nextEpochInFormatted = formatBlocksToTime(remainingBlocks);
        const estimatedCompletionTimestampMs = estimateCompletionTimeMs(remainingBlocks);
        currentEpochProgressDetails = {
            currentEpochIndexFromProgress: sessionInfo.currentIndex.toNumber(),
            totalBlocksInEpoch, currentBlockInEpoch, remainingBlocks,
            percentage: parseFloat(percentage.toFixed(2)),
            nextEpochETAFormatted: nextEpochInFormatted,
            estimatedEpochCompletionTime: estimatedCompletionTimestampMs ? new Date(estimatedCompletionTimestampMs).toISOString() : null,
        };
    } catch (error) {
        await logMessage(`Error mengambil data progress epoch: ${error.message}`, 'ERROR');
        currentEpochProgressDetails = {
            currentEpochIndexFromProgress: lastKnownNetworkEpoch,
            totalBlocksInEpoch: 0, currentBlockInEpoch: 0, remainingBlocks: 0, percentage: 0,
            nextEpochETAFormatted: 'N/A', estimatedEpochCompletionTime: null,
        };
    }
}

function calculatePhraseNumber(currentEpoch) {
    if (currentEpoch < FIRST_EVER_PHRASE_START_EPOCH) return 0;
    const epochsSinceFirst = currentEpoch - FIRST_EVER_PHRASE_START_EPOCH;
    return Math.floor(epochsSinceFirst / PHRASE_DURATION_EPOCHS) + 1;
}

function getStartEpochForPhrase(phraseNumber) {
    if (phraseNumber < 1) return -1;
    return FIRST_EVER_PHRASE_START_EPOCH + (phraseNumber - 1) * PHRASE_DURATION_EPOCHS;
}

async function getBlockTimestampFromChain(blockNumber) {
    if (!polkadotApi || !polkadotApi.isConnected || typeof blockNumber !== 'number' || blockNumber < 1) return null;
    try {
        const blockHash = await polkadotApi.rpc.chain.getBlockHash(blockNumber);
        if (!blockHash || blockHash.isEmpty) return null;
        const signedBlock = await polkadotApi.rpc.chain.getBlock(blockHash);
        const extrinsics = signedBlock.block.extrinsics;
        const timestampExtrinsic = extrinsics.find(ex => ex.method.section === 'timestamp' && ex.method.method === 'set');
        if (timestampExtrinsic) return new Date(timestampExtrinsic.method.args[0].toNumber()).toISOString();
        return null;
    } catch (error) {
        logMessage(`Error mengambil timestamp untuk blok #${blockNumber}: ${error.message}`, 'ERROR');
        return null;
    }
}

async function getFirstBlockOfEpoch(targetEpoch) {
    if (!polkadotApi || !polkadotApi.isConnected) return null;
    try {
        const currentEpochOnChain = (await polkadotApi.query.session.currentIndex()).toNumber();
        const currentBlockHeader = await polkadotApi.rpc.chain.getHeader();
        const currentBlockNumber = currentBlockHeader.number.toNumber();

        if (targetEpoch === currentEpochOnChain) {
            const sessionProgress = await polkadotApi.derive.session.progress();
            if (targetEpoch === sessionProgress.currentIndex.toNumber()) {
                const firstBlock = currentBlockNumber - sessionProgress.sessionProgress.toNumber();
                return Math.max(1, firstBlock);
            }
        }
        return null;
    } catch (error) {
        logMessage(`Error dalam getFirstBlockOfEpoch untuk epoch ${targetEpoch}: ${error.message}`, 'ERROR');
        return null;
    }
}

function getValidatorKeyFromAllowlistEntry(serverConfig) {
    return serverConfig.address || serverConfig.name;
}

function initializeValidatorPhraseEpochDataForApiHelper(validatorKey, phraseNumber, phraseStartEpoch, epochToMonitor, currentTime, isSkipped = false) {
    const phraseKey = `phrase_${phraseNumber}`;
    if (!validatorKey || typeof phraseNumber !== 'number' || phraseNumber < 1 || typeof epochToMonitor !== 'number') {
        logMessage(`Gagal inisialisasi data: parameter tidak valid (validatorKey: ${validatorKey}, phraseNumber: ${phraseNumber}, epochToMonitor: ${epochToMonitor})`, 'ERROR');
        return;
    }
    if (!phraseMonitoringData[validatorKey]) phraseMonitoringData[validatorKey] = {};
    if (!phraseMonitoringData[validatorKey][phraseKey]) {
        phraseMonitoringData[validatorKey][phraseKey] = {
            phraseStartEpoch: phraseStartEpoch,
            phraseEndEpoch: phraseStartEpoch + PHRASE_DURATION_EPOCHS - 1,
            phraseStartTime: null,
            epochs: {}
        };
        logMessage(`Menginisialisasi data frasa API helper ${phraseNumber} (Epoch ${phraseStartEpoch}-${phraseMonitoringData[validatorKey][phraseKey].phraseEndEpoch}) untuk ${validatorKey}.`, 'PHRASE');
    }
    const existingEpoch = phraseMonitoringData[validatorKey][phraseKey].epochs[epochToMonitor];
    if (!existingEpoch || (existingEpoch.status === 'SKIP_HISTORIS' && !isSkipped) || (existingEpoch.status === 'BERJALAN' && isSkipped)) {
        const initialStatus = isSkipped ? 'SKIP_HISTORIS' : 'BERJALAN';
        const initialLastState = isSkipped ? 'TIDAK_DIKETAHUI' : 'AKTIF_API'; // Default ke AKTIF_API saat mulai monitoring epoch berjalan
        const initialTimestamp = isSkipped ? null : currentTime;
        phraseMonitoringData[validatorKey][phraseKey].epochs[epochToMonitor] = {
            totalApiHelperInactiveSeconds: existingEpoch?.totalApiHelperInactiveSeconds || 0,
            status: initialStatus, epochStartTime: null,
            lastApiHelperState: existingEpoch?.lastApiHelperState && !isSkipped ? existingEpoch.lastApiHelperState : initialLastState,
            lastApiHelperStateChangeTimestamp: existingEpoch?.lastApiHelperStateChangeTimestamp && !isSkipped ? existingEpoch.lastApiHelperStateChangeTimestamp : initialTimestamp,
            failThresholdExceeded: existingEpoch?.failThresholdExceeded || false,
            firstMonitoredTimestamp: existingEpoch?.firstMonitoredTimestamp || initialTimestamp
        };
        if (isSkipped) { if (!existingEpoch || existingEpoch.status !== 'SKIP_HISTORIS') logMessage(`Menandai epoch API helper ${epochToMonitor} (frasa ${phraseNumber}) untuk ${validatorKey} sebagai SKIP_HISTORIS.`, 'EPOCH'); }
        else { if (!existingEpoch || existingEpoch.status !== 'BERJALAN') logMessage(`Menginisialisasi data epoch API helper ${epochToMonitor} (frasa ${phraseNumber}) untuk ${validatorKey} sebagai BERJALAN.`, 'EPOCH'); }
    }
}

function updateApiHelperInactiveDuration(validatorKey, phraseNumber, epoch, currentTime) {
    const phraseKey = `phrase_${phraseNumber}`;
    const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[epoch];
    if (!epochData || epochData.status === 'SKIP_HISTORIS' || !epochData.lastApiHelperStateChangeTimestamp) return;

    if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API') {
        const inactiveDuration = Math.round((currentTime - new Date(epochData.lastApiHelperStateChangeTimestamp).getTime()) / 1000);
        if (inactiveDuration > 0) {
            epochData.totalApiHelperInactiveSeconds += inactiveDuration;
            logMessage(`Validator ${validatorKey}, Frasa ${phraseNumber}, Epoch ${epoch}: +${inactiveDuration}d API helper tidak aktif. Total: ${epochData.totalApiHelperInactiveSeconds}d.`, 'EPOCH');
        }
    }
    epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString(); // Selalu update dengan timestamp baru
}

async function handleApiHelperEpochEnd(finishedEpoch, phraseNumberForFinishedEpoch) {
    await logMessage(`--- Akhir Epoch ${finishedEpoch} Terdeteksi untuk Pemantauan API Helper (Frasa ${phraseNumberForFinishedEpoch}) ---`, 'EPOCH');
    const currentTime = Date.now();
    const allowlist = await loadAllowlist(); // Muat allowlist untuk referensi jika diperlukan, meskipun tidak langsung digunakan di sini
    const phraseKey = `phrase_${phraseNumberForFinishedEpoch}`;

    for (const phoneKey of Object.keys(allowlist)) { // Iterasi berdasarkan allowlist untuk memastikan semua validator tercover
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.address) continue;
        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

        const phraseStruct = phraseMonitoringData[validatorKey]?.[phraseKey];
        if (!phraseStruct || !phraseStruct.epochs[finishedEpoch]) {
            // Mungkin validator ini baru ditambahkan atau tidak ada data untuk epoch ini
            // logMessage(`Tidak ada data epoch ${finishedEpoch} untuk validator ${validatorKey} di frasa ${phraseNumberForFinishedEpoch}. Melewati evaluasi akhir epoch.`, 'DEBUG');
            continue;
        }

        const epochData = phraseStruct.epochs[finishedEpoch];
        if (epochData.status === 'SKIP_HISTORIS') {
            await logMessage(`VALIDATOR ${validatorKey}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: Status = SKIP_HISTORIS. Tidak dievaluasi.`, 'EPOCH');
            continue;
        }

        // Jika epoch berakhir dan status terakhir adalah TIDAK_AKTIF_API, update durasi tidak aktifnya
        if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API') {
            updateApiHelperInactiveDuration(validatorKey, phraseNumberForFinishedEpoch, finishedEpoch, currentTime);
        }

        if (epochData.totalApiHelperInactiveSeconds > EPOCH_FAIL_THRESHOLD_SECONDS) {
            epochData.status = 'FAIL_API_HELPER';
            epochData.failThresholdExceeded = true;
            await logMessage(`VALIDATOR ${validatorKey}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: STATUS API HELPER = FAIL (Total tidak aktif: ${epochData.totalApiHelperInactiveSeconds} detik)`, 'EPOCH');
        } else {
            epochData.status = 'PASS_API_HELPER';
            await logMessage(`VALIDATOR ${validatorKey}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: STATUS API HELPER = PASS (Total tidak aktif: ${epochData.totalApiHelperInactiveSeconds} detik)`, 'EPOCH');
        }
        // Hapus state sementara setelah evaluasi
        delete epochData.lastApiHelperState;
        delete epochData.lastApiHelperStateChangeTimestamp;
    }

    if (Object.keys(phraseMonitoringData).length > 0 && phraseNumberForFinishedEpoch >= 1) {
        await savePhraseMonitoringData(phraseNumberForFinishedEpoch, phraseMonitoringData);
    } else {
        await logMessage(`Tidak ada data untuk disimpan atau nomor frasa tidak valid (${phraseNumberForFinishedEpoch}) pada akhir epoch ${finishedEpoch}.`, 'WARN');
    }
}

async function handleApiHelperNewEpochStart(newEpoch, currentPhraseNumberForNew, currentPhraseStartEpochForNew) {
    await logMessage(`--- Awal Epoch Baru ${newEpoch} Terdeteksi untuk Pemantauan API Helper (Frasa ${currentPhraseNumberForNew}, mulai ${currentPhraseStartEpochForNew}) ---`, 'EPOCH');
    const currentTime = Date.now();
    const allowlist = await loadAllowlist();
    const phraseKey = `phrase_${currentPhraseNumberForNew}`;
    const firstBlockOfNewEpoch = await getFirstBlockOfEpoch(newEpoch);
    const newEpochStartTime = firstBlockOfNewEpoch ? await getBlockTimestampFromChain(firstBlockOfNewEpoch) : null;
    let dataWasUpdatedForEpochStartTime = false;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.address) continue;
        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

        // Inisialisasi data untuk epoch baru jika belum ada
        initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumberForNew, currentPhraseStartEpochForNew, newEpoch, currentTime, false);

        const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[newEpoch];
        if (epochData) {
            if (epochData.epochStartTime !== newEpochStartTime) { // Hanya update & log jika berbeda atau belum diset
                epochData.epochStartTime = newEpochStartTime;
                dataWasUpdatedForEpochStartTime = true; // Tandai bahwa ada pembaruan
                if (newEpochStartTime) logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Waktu mulai epoch tercatat ${newEpochStartTime}.`, 'EPOCH');
                else logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Gagal mendapatkan waktu mulai epoch.`, 'WARN');
            }
        }
    }
    // Simpan data jika ada pembaruan epochStartTime
    if (dataWasUpdatedForEpochStartTime && Object.keys(phraseMonitoringData).length > 0 && currentPhraseNumberForNew >= 1) {
        await savePhraseMonitoringData(currentPhraseNumberForNew, phraseMonitoringData);
    }
}

async function epochAndPhraseManagementLoopForApiHelper() {
    try {
        const currentNetworkEpoch = await getCurrentNetworkEpochFromPolkadotApi();
        if (currentNetworkEpoch === -1) {
            await logMessage("Gagal mendapatkan epoch jaringan, tidak dapat melanjutkan manajemen frasa/epoch API helper.", 'ERROR');
            epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
            return;
        }
        await updateCurrentEpochProgressDetails();
        if (currentEpochProgressDetails.currentEpochIndexFromProgress !== null && currentEpochProgressDetails.currentEpochIndexFromProgress !== currentNetworkEpoch) {
            await logMessage(`Peringatan: Epoch dari progress (${currentEpochProgressDetails.currentEpochIndexFromProgress}) tidak sama dengan epoch jaringan (${currentNetworkEpoch}). Menggunakan epoch jaringan (${currentNetworkEpoch}).`, 'WARN');
        }
        const effectiveCurrentEpoch = currentNetworkEpoch; // Gunakan currentNetworkEpoch sebagai sumber kebenaran

        if (currentEpochProgressDetails.estimatedEpochCompletionTime) {
            logMessage(`Epoch ${effectiveCurrentEpoch} berjalan. Estimasi selesai: ${new Date(currentEpochProgressDetails.estimatedEpochCompletionTime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}, ETA: ${currentEpochProgressDetails.nextEpochETAFormatted}`, 'EPOCH');
        }

        const calculatedCurrentPhraseNumber = calculatePhraseNumber(effectiveCurrentEpoch);
        let calculatedCurrentPhraseStartEpoch = getStartEpochForPhrase(calculatedCurrentPhraseNumber);

        if (calculatedCurrentPhraseNumber < 1) {
            if (currentPhraseNumber === -1) { // Hanya log sekali saat pertama kali
                await logMessage(`Epoch jaringan (${effectiveCurrentEpoch}) lebih awal dari frasa pertama (${FIRST_EVER_PHRASE_START_EPOCH}). Menunggu.`, 'PHRASE');
            }
            lastKnownNetworkEpoch = effectiveCurrentEpoch;
            epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
            return;
        }
        const calculatedCurrentPhraseEndEpoch = calculatedCurrentPhraseStartEpoch + PHRASE_DURATION_EPOCHS - 1;

        // Deteksi perubahan frasa
        if (currentPhraseNumber !== -1 && currentPhraseNumber !== calculatedCurrentPhraseNumber) {
            await logMessage(`--- Frasa Baru API Helper Terdeteksi (Dari Frasa ${currentPhraseNumber} ke Frasa ${calculatedCurrentPhraseNumber}) ---`, 'PHRASE');
            // Muat data untuk frasa baru jika ada
            const loadedDataForNewPhrase = await loadPhraseMonitoringData(calculatedCurrentPhraseNumber);
            for (const validatorKey in loadedDataForNewPhrase) {
                if (!phraseMonitoringData[validatorKey]) phraseMonitoringData[validatorKey] = {};
                phraseMonitoringData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`] = loadedDataForNewPhrase[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`];
            }
        }

        // Inisialisasi atau update frasa saat ini
        if (currentPhraseNumber !== calculatedCurrentPhraseNumber || (Object.keys(phraseMonitoringData).length === 0 && calculatedCurrentPhraseNumber >= 1)) {
            if (Object.keys(phraseMonitoringData).length === 0 && calculatedCurrentPhraseNumber >= 1 && currentPhraseNumber === -1) { // Hanya load jika phraseMonitoringData kosong dan ini bukan perubahan frasa
                const loadedInitialData = await loadPhraseMonitoringData(calculatedCurrentPhraseNumber);
                for (const validatorKey in loadedInitialData) {
                    if (!phraseMonitoringData[validatorKey]) phraseMonitoringData[validatorKey] = {};
                    // Pastikan hanya memuat data frasa yang relevan
                    if (loadedInitialData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`]) {
                        phraseMonitoringData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`] = loadedInitialData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`];
                    }
                }
            }

            const allowlist = await loadAllowlist();
            const currentTime = Date.now();
            for (const phoneKey of Object.keys(allowlist)) {
                const serverConfig = allowlist[phoneKey];
                if (!serverConfig || !serverConfig.address) continue;
                const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

                // Inisialisasi epoch historis dalam frasa saat ini sebagai SKIP_HISTORIS jika belum ada datanya
                if (calculatedCurrentPhraseStartEpoch <= effectiveCurrentEpoch) {
                    for (let epochInCurrentPhrase = calculatedCurrentPhraseStartEpoch; epochInCurrentPhrase < effectiveCurrentEpoch; epochInCurrentPhrase++) {
                        if (epochInCurrentPhrase <= calculatedCurrentPhraseEndEpoch) { // Pastikan epoch masih dalam rentang frasa
                            const phraseKeyForInit = `phrase_${calculatedCurrentPhraseNumber}`;
                            const existingEpochData = phraseMonitoringData[validatorKey]?.[phraseKeyForInit]?.epochs?.[epochInCurrentPhrase];
                            if (!existingEpochData || !['PASS_API_HELPER', 'FAIL_API_HELPER', 'SKIP_HISTORIS'].includes(existingEpochData.status)) {
                                initializeValidatorPhraseEpochDataForApiHelper(validatorKey, calculatedCurrentPhraseNumber, calculatedCurrentPhraseStartEpoch, epochInCurrentPhrase, currentTime, true);
                            }
                        }
                    }
                }
                // Inisialisasi epoch saat ini dalam frasa saat ini sebagai BERJALAN
                if (effectiveCurrentEpoch >= calculatedCurrentPhraseStartEpoch && effectiveCurrentEpoch <= calculatedCurrentPhraseEndEpoch) {
                    initializeValidatorPhraseEpochDataForApiHelper(validatorKey, calculatedCurrentPhraseNumber, calculatedCurrentPhraseStartEpoch, effectiveCurrentEpoch, currentTime, false);
                }
            }

            // Catat waktu mulai frasa jika ini adalah epoch pertama dari frasa tersebut
            if (effectiveCurrentEpoch === calculatedCurrentPhraseStartEpoch) {
                const firstBlockCurrentPhrase = await getFirstBlockOfEpoch(calculatedCurrentPhraseStartEpoch);
                const phraseStartTime = firstBlockCurrentPhrase ? await getBlockTimestampFromChain(firstBlockCurrentPhrase) : null;
                const allowlistForPhraseStart = await loadAllowlist(); // Muat ulang untuk data terbaru
                let dataWasUpdatedForPhraseStartTime = false;
                for (const phoneKey of Object.keys(allowlistForPhraseStart)) {
                    const serverConfig = allowlistForPhraseStart[phoneKey];
                    if (!serverConfig || !serverConfig.address) continue;
                    const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);
                    const phraseKeyForStartTime = `phrase_${calculatedCurrentPhraseNumber}`;
                    if (phraseMonitoringData[validatorKey]?.[phraseKeyForStartTime] && phraseMonitoringData[validatorKey][phraseKeyForStartTime].phraseStartTime !== phraseStartTime) {
                        phraseMonitoringData[validatorKey][phraseKeyForStartTime].phraseStartTime = phraseStartTime;
                        dataWasUpdatedForPhraseStartTime = true;
                        if (phraseStartTime) logMessage(`Frasa ${calculatedCurrentPhraseNumber} untuk ${validatorKey} dimulai pada ${phraseStartTime}.`, 'PHRASE');
                    }
                }
                if (dataWasUpdatedForPhraseStartTime) {
                    await savePhraseMonitoringData(calculatedCurrentPhraseNumber, phraseMonitoringData);
                }
            }
        }
        currentPhraseNumber = calculatedCurrentPhraseNumber;
        currentPhraseStartEpochForMonitoring = calculatedCurrentPhraseStartEpoch;

        // Penanganan akhir epoch dan awal epoch baru
        if (lastKnownNetworkEpoch !== -1 && effectiveCurrentEpoch > lastKnownNetworkEpoch) {
            for (let epochJustFinished = lastKnownNetworkEpoch; epochJustFinished < effectiveCurrentEpoch; epochJustFinished++) {
                const phraseNumberOfFinishedEpoch = calculatePhraseNumber(epochJustFinished);
                if (phraseNumberOfFinishedEpoch >= 1) { // Pastikan frasa valid
                    // Pastikan epoch yang selesai berada dalam frasa yang benar sebelum memanggil handleApiHelperEpochEnd
                    const startEpochForFinishedPhrase = getStartEpochForPhrase(phraseNumberOfFinishedEpoch);
                    const endEpochForFinishedPhrase = startEpochForFinishedPhrase + PHRASE_DURATION_EPOCHS - 1;
                    if (epochJustFinished >= startEpochForFinishedPhrase && epochJustFinished <= endEpochForFinishedPhrase) {
                        await handleApiHelperEpochEnd(epochJustFinished, phraseNumberOfFinishedEpoch);
                    } else {
                        // logMessage(`Epoch ${epochJustFinished} tidak diproses untuk akhir epoch karena di luar rentang frasa ${phraseNumberOfFinishedEpoch} (${startEpochForFinishedPhrase}-${endEpochForFinishedPhrase})`, 'DEBUG');
                    }
                }
            }
            // Panggil awal epoch baru untuk epoch saat ini jika berada dalam frasa yang sedang dimonitor
            if (effectiveCurrentEpoch >= currentPhraseStartEpochForMonitoring && effectiveCurrentEpoch <= (currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1)) {
                await handleApiHelperNewEpochStart(effectiveCurrentEpoch, currentPhraseNumber, currentPhraseStartEpochForMonitoring);
            }
        } else if (lastKnownNetworkEpoch === -1 && effectiveCurrentEpoch !== -1 && currentPhraseNumber !== -1) { // Kasus inisialisasi pertama
            if (effectiveCurrentEpoch >= currentPhraseStartEpochForMonitoring && effectiveCurrentEpoch <= (currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1)) {
                await handleApiHelperNewEpochStart(effectiveCurrentEpoch, currentPhraseNumber, currentPhraseStartEpochForMonitoring);
            }
        }
        lastKnownNetworkEpoch = effectiveCurrentEpoch;

    } catch (error) {
        await logMessage(`Error dalam epochAndPhraseManagementLoopForApiHelper: ${error.message} ${error.stack || ''}`, 'ERROR');
    } finally {
        epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
    }
}

async function checkApiHelperStatusForAllNodes() {
    await logMessage('Memulai siklus pengecekan status API helper dari allowlist (field "status")...', 'API_HELPER');
    const allowlist = await loadAllowlist(); // Muat allowlist terbaru setiap siklus
    const currentTime = Date.now(); // Timestamp saat ini dalam milidetik

    if (currentPhraseNumber === -1 || lastKnownNetworkEpoch === -1) {
        await logMessage("Epoch/frasa jaringan belum diketahui. Pengecekan status API helper ditunda.", 'WARN');
        return;
    }

    const phraseKey = `phrase_${currentPhraseNumber}`;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];

        if (!serverConfig || !serverConfig.name || !serverConfig.address) {
            await logMessage(`Konfigurasi dasar (name/address) tidak lengkap untuk entri ${phoneKey}. Melewati.`, 'WARN');
            continue;
        }

        if (typeof serverConfig.status === 'undefined') {
            await logMessage(`Field 'status' tidak ditemukan untuk ${serverConfig.name} (${validatorKey}) di allowlist.json. Melewati.`, 'WARN');
            continue;
        }

        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);
        // Pastikan data epoch diinisialisasi jika belum ada (misalnya jika skrip baru dimulai di tengah epoch)
        initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumber, currentPhraseStartEpochForMonitoring, lastKnownNetworkEpoch, currentTime, false);

        const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[lastKnownNetworkEpoch];
        if (!epochData || epochData.status !== 'BERJALAN') { // Hanya proses epoch yang statusnya 'BERJALAN'
            // logMessage(`Epoch ${lastKnownNetworkEpoch} untuk ${validatorKey} tidak dalam status BERJALAN (status: ${epochData?.status}). Pengecekan API helper dilewati.`, 'DEBUG');
            continue;
        }

        let currentApiHelperIsConsideredActive = false;
        let apiHelperStatusFromAllowlist = String(serverConfig.status).trim().toLowerCase();

        if (apiHelperStatusFromAllowlist === "active") {
            currentApiHelperIsConsideredActive = true;
        } else {
            currentApiHelperIsConsideredActive = false;
            // Log jika statusnya bukan "active" untuk kejelasan
            if (apiHelperStatusFromAllowlist !== "inactive") {
                await logMessage(`API Helper ${serverConfig.name} (${validatorKey}): Status dari allowlist adalah '${serverConfig.status}'. Dianggap TIDAK AKTIF.`, 'WARN');
            } else {
                // Tidak perlu log khusus jika memang "inactive", transisi akan dicatat
            }
        }

        const previousApiHelperState = epochData.lastApiHelperState;

        if (previousApiHelperState === 'AKTIF_API' && !currentApiHelperIsConsideredActive) {
            await logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Transisi API Helper AKTIF -> TIDAK AKTIF (Status dari allowlist: ${serverConfig.status})`, 'EPOCH');
            updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
            epochData.lastApiHelperState = 'TIDAK_AKTIF_API';
        } else if (previousApiHelperState === 'TIDAK_AKTIF_API' && currentApiHelperIsConsideredActive) {
            await logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Transisi API Helper TIDAK AKTIF -> AKTIF (Status dari allowlist: ${serverConfig.status})`, 'EPOCH');
            updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime); // Update durasi sebelum mengubah state
            epochData.lastApiHelperState = 'AKTIF_API';
        } else if (previousApiHelperState === 'TIDAK_AKTIF_API' && !currentApiHelperIsConsideredActive) {
            // Tetap tidak aktif, update durasi
            updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
        } else if (previousApiHelperState === 'AKTIF_API' && currentApiHelperIsConsideredActive) {
            // Tetap aktif, hanya update timestamp terakhir state berubah (atau timestamp pengecekan)
            epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString();
        } else if (previousApiHelperState === 'TIDAK_DIKETAHUI') { // Kasus inisialisasi awal epoch
            if (currentApiHelperIsConsideredActive) {
                epochData.lastApiHelperState = 'AKTIF_API';
            } else {
                epochData.lastApiHelperState = 'TIDAK_AKTIF_API';
                // Langsung update durasi karena dimulai sebagai tidak aktif
                updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
            }
            await logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Status API Helper awal terdeteksi sebagai ${epochData.lastApiHelperState} (dari allowlist: ${serverConfig.status})`, 'EPOCH');
        }
    }

    if (Object.keys(phraseMonitoringData).length > 0 && currentPhraseNumber !== -1) {
        await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
    }
    await logMessage('Siklus pengecekan status API helper dari allowlist (field "status") selesai.', 'API_HELPER');
}

async function initializeAndStartMonitoring() {
    await logMessage('Memulai API Helper Monitor...', 'SYSTEM');
    try {
        await fs.mkdir(CONFIG_DIR, { recursive: true }); // Pastikan direktori config ada
        await fs.mkdir(path.join(ROOT_DIR, 'logs'), { recursive: true }); // Pastikan direktori logs ada
        await fs.mkdir(PHRASE_DATA_DIR, { recursive: true });
    } catch (err) {
        console.error(`FATAL: Gagal membuat direktori yang diperlukan: ${err.message}`);
        process.exit(1);
    }

    const initialNetworkEpoch = await getCurrentNetworkEpochFromPolkadotApi();
    if (initialNetworkEpoch === -1) {
        await logMessage("Gagal mendapatkan epoch jaringan pada inisialisasi. Penjadwalan ulang inisialisasi.", 'ERROR');
        setTimeout(initializeAndStartMonitoring, EPOCH_CHECK_INTERVAL_MS); // Coba lagi setelah interval
        return;
    }
    lastKnownNetworkEpoch = initialNetworkEpoch; // Set lastKnownNetworkEpoch di sini

    let initialPhraseNumber = calculatePhraseNumber(initialNetworkEpoch);
    let initialPhraseStartEpoch;

    if (initialPhraseNumber < 1) {
        // Jika epoch jaringan sebelum frasa pertama, set ke frasa 1 untuk persiapan
        currentPhraseNumber = 1;
        currentPhraseStartEpochForMonitoring = FIRST_EVER_PHRASE_START_EPOCH;
        phraseMonitoringData = {}; // Mulai dengan data kosong
        await logMessage(`Epoch jaringan (${initialNetworkEpoch}) lebih awal dari frasa pertama (${FIRST_EVER_PHRASE_START_EPOCH}). Menunggu frasa pertama (Frasa ${currentPhraseNumber}).`, 'PHRASE');
    } else {
        currentPhraseNumber = initialPhraseNumber;
        currentPhraseStartEpochForMonitoring = getStartEpochForPhrase(currentPhraseNumber);
        // Muat data yang ada untuk frasa saat ini
        const loadedData = await loadPhraseMonitoringData(currentPhraseNumber);
        phraseMonitoringData = loadedData || {};
    }

    // Inisialisasi data untuk semua validator di allowlist untuk frasa saat ini
    const allowlist = await loadAllowlist();
    const currentTime = Date.now();
    const currentCalculatedPhraseEndEpoch = currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.address) continue;
        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

        if (!phraseMonitoringData[validatorKey]) phraseMonitoringData[validatorKey] = {};
        const phraseKey = `phrase_${currentPhraseNumber}`;
        if (!phraseMonitoringData[validatorKey][phraseKey]) {
            phraseMonitoringData[validatorKey][phraseKey] = {
                phraseStartEpoch: currentPhraseStartEpochForMonitoring,
                phraseEndEpoch: currentCalculatedPhraseEndEpoch,
                phraseStartTime: null,
                epochs: {}
            };
        }

        // Catat waktu mulai frasa jika ini adalah epoch pertama dari frasa dan belum tercatat
        if (initialNetworkEpoch === currentPhraseStartEpochForMonitoring && !phraseMonitoringData[validatorKey][phraseKey].phraseStartTime) {
            const firstBlockCurrentPhrase = await getFirstBlockOfEpoch(currentPhraseStartEpochForMonitoring);
            const phraseStartTimeVal = firstBlockCurrentPhrase ? await getBlockTimestampFromChain(firstBlockCurrentPhrase) : null;
            if (phraseStartTimeVal) {
                phraseMonitoringData[validatorKey][phraseKey].phraseStartTime = phraseStartTimeVal;
                logMessage(`Frasa ${currentPhraseNumber} untuk ${validatorKey} dimulai pada ${phraseStartTimeVal}.`, 'PHRASE');
            }
        }

        // Inisialisasi epoch historis dalam frasa saat ini sebagai SKIP_HISTORIS
        if (currentPhraseStartEpochForMonitoring <= initialNetworkEpoch) {
            for (let epochToInit = currentPhraseStartEpochForMonitoring; epochToInit < initialNetworkEpoch; epochToInit++) {
                if (epochToInit <= currentCalculatedPhraseEndEpoch) {
                    const existingEpochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[epochToInit];
                    if (!existingEpochData || !['PASS_API_HELPER', 'FAIL_API_HELPER', 'SKIP_HISTORIS'].includes(existingEpochData.status)) {
                        initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumber, currentPhraseStartEpochForMonitoring, epochToInit, currentTime, true);
                    }
                }
            }
        }

        // Inisialisasi epoch saat ini sebagai BERJALAN
        if (initialNetworkEpoch >= currentPhraseStartEpochForMonitoring && initialNetworkEpoch <= currentCalculatedPhraseEndEpoch) {
            initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumber, currentPhraseStartEpochForMonitoring, initialNetworkEpoch, currentTime, false);
            const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[initialNetworkEpoch];
            if (epochData && !epochData.epochStartTime) { // Jika epochStartTime belum ada
                const firstBlockCurrentEpoch = await getFirstBlockOfEpoch(initialNetworkEpoch);
                const epochStartTimeVal = firstBlockCurrentEpoch ? await getBlockTimestampFromChain(firstBlockCurrentEpoch) : null;
                if (epochStartTimeVal) {
                    epochData.epochStartTime = epochStartTimeVal;
                    logMessage(`Epoch ${initialNetworkEpoch} (Frasa ${currentPhraseNumber}) untuk ${validatorKey} dimulai pada ${epochStartTimeVal}.`, 'EPOCH');
                }
            }
        }
    }

    if (currentPhraseNumber !== -1 && Object.keys(phraseMonitoringData).length > 0) {
        await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
    }

    // Mulai loop utama
    epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, 0); // Mulai manajemen epoch segera

    // Hapus interval lama jika ada sebelum membuat yang baru
    if (apiHelperCheckIntervalId) clearInterval(apiHelperCheckIntervalId);
    apiHelperCheckIntervalId = setInterval(checkApiHelperStatusForAllNodes, CHECK_INTERVAL_MS); // Pengecekan status API Helper periodik

    await logMessage(`Pengecekan status API helper dari allowlist (field "status") dijadwalkan setiap ${CHECK_INTERVAL_MS / 60000} menit.`, 'SYSTEM');
    await logMessage(`Manajemen Epoch & Frasa dijadwalkan setiap ${EPOCH_CHECK_INTERVAL_MS / 60000} menit.`, 'SYSTEM');
}

initializeAndStartMonitoring().catch(error => {
    logMessage(`Error kritis saat inisialisasi API Helper Monitor: ${error.message} ${error.stack || ''}`, 'ERROR');
    process.exit(1);
});

process.on('SIGINT', async () => {
    await logMessage('SIGINT diterima. Menghentikan API Helper Monitor dan menyimpan data terakhir...', 'SYSTEM');
    if (apiHelperCheckIntervalId) clearInterval(apiHelperCheckIntervalId);
    if (epochCheckIntervalId) clearTimeout(epochCheckIntervalId);
    if (polkadotApi) await polkadotApi.disconnect().catch(e => logMessage(`Error saat disconnect API global pada SIGINT: ${e.message}`, 'ERROR'));

    const currentTimeForExit = Date.now();
    // Update durasi tidak aktif terakhir sebelum keluar jika epoch saat ini sedang berjalan dan statusnya tidak aktif
    if (lastKnownNetworkEpoch !== -1 && currentPhraseNumber !== -1) {
        const allowlist = await loadAllowlist().catch(() => ({})); // Muat allowlist, default ke objek kosong jika gagal
        for (const phoneKey of Object.keys(allowlist)) {
            const serverConfig = allowlist[phoneKey];
            if (!serverConfig || !serverConfig.address) continue;
            const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);
            const phraseKey = `phrase_${currentPhraseNumber}`;
            const phraseData = phraseMonitoringData[validatorKey]?.[phraseKey];
            if (phraseData && phraseData.epochs[lastKnownNetworkEpoch]) {
                const epochData = phraseData.epochs[lastKnownNetworkEpoch];
                if (epochData.status === 'BERJALAN' && epochData.lastApiHelperState === 'TIDAK_AKTIF_API') {
                    updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTimeForExit);
                }
            }
        }
    }

    if (currentPhraseNumber !== -1 && Object.keys(phraseMonitoringData).length > 0) {
        await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
    }
    await logMessage('API Helper Monitor dihentikan.', 'SYSTEM');
    process.exit(0);
});
