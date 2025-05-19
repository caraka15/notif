// api_helper_monitor.js
const { ApiPromise, WsProvider } = require('@polkadot/api'); // Untuk mendapatkan epoch jaringan
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const chalk = require('chalk'); // Opsional, untuk logging berwarna

// --- Konfigurasi Path & Dasar ---
const ROOT_DIR = '/root/notif'; // Sesuaikan jika perlu
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const ALLOWLIST_PATH = path.join(CONFIG_DIR, 'allowlist.json'); // Sumber utama konfigurasi node
const LOG_FILE_PATH = path.join(ROOT_DIR, 'logs', 'api_helper_monitor.log'); // Log khusus untuk skrip ini
const PHRASE_DATA_DIR = path.join(ROOT_DIR, 'api_helper_phrase_data'); // Direktori data frasa

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Interval pengecekan status API helper (5 menit)
const EPOCH_CHECK_INTERVAL_MS = 60000;   // Interval pengecekan epoch jaringan (1 menit)
const FIRST_EVER_PHRASE_START_EPOCH = 5450;
const PHRASE_DURATION_EPOCHS = 84;
const EPOCH_FAIL_THRESHOLD_SECONDS = 2 * 60 * 60; // 2 jam
const GLOBAL_RPC_ENDPOINT = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io'; // Untuk info epoch
const EPOCH_DURATION_HOURS = 4; // Durasi epoch dalam jam (untuk referensi, tidak digunakan dalam kalkulasi utama saat ini)
const EPOCH_DURATION_SECONDS = EPOCH_DURATION_HOURS * 60 * 60;


// --- Variabel State Global ---
// PERBAIKAN: Struktur data sekarang menggunakan `phrase_${phraseNumber}` sebagai kunci
let phraseMonitoringData = {}; // { validatorAddress: { `phrase_${phraseNumber}`: { phraseStartEpoch: X, phraseEndEpoch: Y, phraseStartTime: timestamp, epochs: { Y: { totalApiHelperInactiveSeconds: N, status: 'BERJALAN'|'PASS_API_HELPER'|'FAIL_API_HELPER'|'SKIP_HISTORIS', epochStartTime: timestamp, lastApiHelperState: 'AKTIF_API'|'TIDAK_AKTIF_API', lastApiHelperStateChangeTimestamp: ts } } } } }
let polkadotApi = null;
let lastKnownNetworkEpoch = -1;
let currentPhraseNumber = -1; // Nomor frasa yang sedang dipantau (misalnya, 1, 2, dst.)
let currentPhraseStartEpochForMonitoring = -1; // Epoch awal dari frasa yang sedang dipantau
let apiHelperCheckIntervalId = null;
let epochCheckIntervalId = null;

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
    try {
        await fs.appendFile(LOG_FILE_PATH, logString + '\n');
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [ERROR] Gagal menulis ke file log: ${error.message}`);
    }
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

// PERBAIKAN: Menggunakan nomor frasa untuk nama file
async function savePhraseMonitoringData(phraseNumber, dataToSave) {
    if (typeof phraseNumber !== 'number' || phraseNumber < 1) {
        await logMessage(`Gagal menyimpan data frasa: nomor frasa tidak valid (${phraseNumber}).`, 'ERROR');
        return;
    }
    const filePath = path.join(PHRASE_DATA_DIR, `api_helper_phrase_${phraseNumber}_data.json`);
    try {
        // Hanya simpan data untuk frasa yang relevan
        const relevantDataForPhrase = {};
        for (const validatorKey in dataToSave) {
            if (dataToSave[validatorKey][`phrase_${phraseNumber}`]) {
                if (!relevantDataForPhrase[validatorKey]) relevantDataForPhrase[validatorKey] = {};
                relevantDataForPhrase[validatorKey][`phrase_${phraseNumber}`] = dataToSave[validatorKey][`phrase_${phraseNumber}`];
            }
        }
        if (Object.keys(relevantDataForPhrase).length > 0) {
            await fs.writeFile(filePath, JSON.stringify(relevantDataForPhrase, null, 2));
            await logMessage(`Data pemantauan API helper frasa ${phraseNumber} disimpan.`, 'PHRASE');
        } else {
            await logMessage(`Tidak ada data relevan untuk disimpan untuk frasa ${phraseNumber}.`, 'PHRASE');
        }
    } catch (error) {
        await logMessage(`Gagal menyimpan data pemantauan API helper frasa ${phraseNumber}: ${error.message}`, 'ERROR');
    }
}

// PERBAIKAN: Menggunakan nomor frasa untuk nama file
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
        return JSON.parse(data); // Ini akan menjadi { validatorKey: { `phrase_${phraseNumber}`: { ... } } }
    } catch (error) {
        if (error.code === 'ENOENT') {
            await logMessage(`Tidak ada data pemantauan API helper tersimpan untuk frasa ${phraseNumber}. Memulai data baru.`, 'PHRASE');
        } else {
            await logMessage(`Gagal memuat data pemantauan API helper untuk frasa ${phraseNumber}: ${error.message}. Memulai data baru.`, 'ERROR');
        }
        return {};
    }
}

async function initializeGlobalPolkadotApi() { /* ... (Tidak berubah) ... */
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


async function getCurrentNetworkEpochFromPolkadotApi() { /* ... (Tidak berubah) ... */
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

// Fungsi baru untuk menghitung nomor frasa
function calculatePhraseNumber(currentEpoch) {
    if (currentEpoch < FIRST_EVER_PHRASE_START_EPOCH) {
        return 0; // Atau nilai lain yang menandakan belum masuk frasa pertama
    }
    const epochsSinceFirst = currentEpoch - FIRST_EVER_PHRASE_START_EPOCH;
    return Math.floor(epochsSinceFirst / PHRASE_DURATION_EPOCHS) + 1;
}

// Fungsi baru untuk mendapatkan epoch awal dari nomor frasa
function getStartEpochForPhrase(phraseNumber) {
    if (phraseNumber < 1) return -1; // Nomor frasa tidak valid
    return FIRST_EVER_PHRASE_START_EPOCH + (phraseNumber - 1) * PHRASE_DURATION_EPOCHS;
}

async function getBlockTimestampFromChain(blockNumber) {
    if (!polkadotApi || !polkadotApi.isConnected || typeof blockNumber !== 'number' || blockNumber < 1) {
        // logMessage(`Tidak bisa mengambil timestamp: API tidak terhubung atau nomor blok tidak valid (${blockNumber}).`, 'WARN');
        return null;
    }
    try {
        const blockHash = await polkadotApi.rpc.chain.getBlockHash(blockNumber);
        if (!blockHash || blockHash.isEmpty) {
            // logMessage(`Timestamp tidak bisa diambil: Hash blok tidak ditemukan untuk blok #${blockNumber}.`, 'WARN');
            return null;
        }
        const signedBlock = await polkadotApi.rpc.chain.getBlock(blockHash);
        const extrinsics = signedBlock.block.extrinsics;
        const timestampExtrinsic = extrinsics.find(ex => ex.method.section === 'timestamp' && ex.method.method === 'set');
        if (timestampExtrinsic) {
            return new Date(timestampExtrinsic.method.args[0].toNumber()).toISOString();
        }
        // logMessage(`Timestamp tidak ditemukan dalam ekstrinsik untuk blok #${blockNumber}.`, 'WARN');
        return null; // Fallback jika tidak ada ekstrinsik timestamp
    } catch (error) {
        logMessage(`Error mengambil timestamp untuk blok #${blockNumber}: ${error.message}`, 'ERROR');
        return null;
    }
}

async function getFirstBlockOfEpoch(targetEpoch) {
    // Implementasi ini masih placeholder dan memerlukan cara yang lebih andal untuk mendapatkan blok pertama epoch historis.
    // Untuk epoch saat ini atau yang baru dimulai, ini bisa lebih mudah.
    // Untuk Humanode, mungkin perlu query event `session.NewSession` atau `babe.EpochChanged` (jika ada)
    // atau menggunakan API eksternal jika tersedia.
    // Saat ini, kita akan mengembalikan null dan menangani ini di tempat pemanggilan.
    if (!polkadotApi || !polkadotApi.isConnected) return null;

    if (targetEpoch === lastKnownNetworkEpoch) { // Jika epoch saat ini
        const epochDuration = await polkadotApi.consts.babe.epochDuration.toNumber();
        const currentBlock = (await polkadotApi.rpc.chain.getHeader()).number.toNumber();
        return currentBlock - (currentBlock % epochDuration);
    }

    // logMessage(`Pengambilan blok pertama untuk epoch historis (${targetEpoch}) adalah fitur lanjutan dan belum diimplementasikan sepenuhnya.`, 'WARN');
    return null;
}


function getValidatorKeyFromAllowlistEntry(serverConfig) { /* ... (Tidak berubah) ... */
    return serverConfig.address || serverConfig.name;
}

// PERBAIKAN: Menggunakan phraseKey (`phrase_${phraseNumber}`)
function initializeValidatorPhraseEpochDataForApiHelper(validatorKey, phraseNumber, phraseStartEpoch, epochToMonitor, currentTime, isSkipped = false) {
    const phraseKey = `phrase_${phraseNumber}`;
    if (!validatorKey || typeof phraseNumber !== 'number' || phraseNumber < 1 || typeof epochToMonitor !== 'number') {
        logMessage(`Gagal inisialisasi data: parameter tidak valid (validatorKey: ${validatorKey}, phraseNumber: ${phraseNumber}, epochToMonitor: ${epochToMonitor})`, 'ERROR');
        return;
    }

    if (!phraseMonitoringData[validatorKey]) {
        phraseMonitoringData[validatorKey] = {};
    }
    if (!phraseMonitoringData[validatorKey][phraseKey]) {
        phraseMonitoringData[validatorKey][phraseKey] = {
            phraseStartEpoch: phraseStartEpoch,
            phraseEndEpoch: phraseStartEpoch + PHRASE_DURATION_EPOCHS - 1,
            phraseStartTime: null, // Akan diisi nanti
            epochs: {}
        };
        logMessage(`Menginisialisasi data frasa API helper ${phraseNumber} (Epoch ${phraseStartEpoch}-${phraseMonitoringData[validatorKey][phraseKey].phraseEndEpoch}) untuk ${validatorKey}.`, 'PHRASE');
    }

    const existingEpoch = phraseMonitoringData[validatorKey][phraseKey].epochs[epochToMonitor];
    if (!existingEpoch || (existingEpoch.status === 'SKIP_HISTORIS' && !isSkipped) || (existingEpoch.status === 'BERJALAN' && isSkipped)) {
        const initialStatus = isSkipped ? 'SKIP_HISTORIS' : 'BERJALAN';
        const initialLastState = isSkipped ? 'TIDAK_DIKETAHUI' : 'AKTIF_API';
        const initialTimestamp = isSkipped ? null : currentTime;

        phraseMonitoringData[validatorKey][phraseKey].epochs[epochToMonitor] = {
            totalApiHelperInactiveSeconds: existingEpoch?.totalApiHelperInactiveSeconds || 0,
            status: initialStatus,
            epochStartTime: null, // Akan diisi nanti
            lastApiHelperState: existingEpoch?.lastApiHelperState && !isSkipped ? existingEpoch.lastApiHelperState : initialLastState,
            lastApiHelperStateChangeTimestamp: existingEpoch?.lastApiHelperStateChangeTimestamp && !isSkipped ? existingEpoch.lastApiHelperStateChangeTimestamp : initialTimestamp,
            failThresholdExceeded: existingEpoch?.failThresholdExceeded || false,
            firstMonitoredTimestamp: existingEpoch?.firstMonitoredTimestamp || initialTimestamp
        };
        if (isSkipped) {
            if (!existingEpoch || existingEpoch.status !== 'SKIP_HISTORIS') {
                logMessage(`Menandai epoch API helper ${epochToMonitor} (frasa ${phraseNumber}) untuk ${validatorKey} sebagai SKIP_HISTORIS.`, 'EPOCH');
            }
        } else {
            if (!existingEpoch || existingEpoch.status !== 'BERJALAN') {
                logMessage(`Menginisialisasi data epoch API helper ${epochToMonitor} (frasa ${phraseNumber}) untuk ${validatorKey} sebagai BERJALAN.`, 'EPOCH');
            }
        }
    }
}

// PERBAIKAN: Menggunakan phraseKey
function updateApiHelperInactiveDuration(validatorKey, phraseNumber, epoch, currentTime) {
    const phraseKey = `phrase_${phraseNumber}`;
    const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[epoch];
    if (!epochData || epochData.status === 'SKIP_HISTORIS' || !epochData.lastApiHelperStateChangeTimestamp) {
        return;
    }
    if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API') {
        const inactiveDuration = Math.round((currentTime - epochData.lastApiHelperStateChangeTimestamp) / 1000);
        if (inactiveDuration > 0) {
            epochData.totalApiHelperInactiveSeconds += inactiveDuration;
            logMessage(`Validator ${validatorKey}, Frasa ${phraseNumber}, Epoch ${epoch}: +${inactiveDuration}d API helper tidak aktif. Total: ${epochData.totalApiHelperInactiveSeconds}d.`, 'EPOCH');
        }
    }
    epochData.lastApiHelperStateChangeTimestamp = currentTime;
}

// PERBAIKAN: Menggunakan phraseKey
async function handleApiHelperEpochEnd(finishedEpoch, phraseNumberForFinishedEpoch) {
    await logMessage(`--- Akhir Epoch ${finishedEpoch} Terdeteksi untuk Pemantauan API Helper (Frasa ${phraseNumberForFinishedEpoch}) ---`, 'EPOCH');
    const currentTime = Date.now();
    const allowlist = await loadAllowlist();
    const phraseKey = `phrase_${phraseNumberForFinishedEpoch}`;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.address) continue;
        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

        const phraseStruct = phraseMonitoringData[validatorKey]?.[phraseKey];
        if (!phraseStruct || !phraseStruct.epochs[finishedEpoch]) continue;

        const epochData = phraseStruct.epochs[finishedEpoch];
        if (epochData.status === 'SKIP_HISTORIS') {
            await logMessage(`VALIDATOR ${validatorKey}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: Status = SKIP_HISTORIS. Tidak dievaluasi.`, 'EPOCH');
            continue;
        }

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
        delete epochData.lastApiHelperState;
        delete epochData.lastApiHelperStateChangeTimestamp;
    }
    if (Object.keys(phraseMonitoringData).length > 0 && phraseNumberForFinishedEpoch !== -1) {
        await savePhraseMonitoringData(phraseNumberForFinishedEpoch, phraseMonitoringData);
    } else {
        await logMessage(`Tidak ada data untuk disimpan atau nomor frasa tidak valid (${phraseNumberForFinishedEpoch}) pada akhir epoch ${finishedEpoch}.`, 'WARN');
    }
}

// PERBAIKAN: Menggunakan phraseKey
async function handleApiHelperNewEpochStart(newEpoch, currentPhraseNumberForNew, currentPhraseStartEpochForNew) {
    await logMessage(`--- Awal Epoch Baru ${newEpoch} Terdeteksi untuk Pemantauan API Helper (Frasa ${currentPhraseNumberForNew}, mulai ${currentPhraseStartEpochForNew}) ---`, 'EPOCH');
    const currentTime = Date.now();
    const allowlist = await loadAllowlist();
    const phraseKey = `phrase_${currentPhraseNumberForNew}`;

    // Coba dapatkan timestamp blok pertama epoch baru
    const firstBlockOfNewEpoch = await getFirstBlockOfEpoch(newEpoch);
    const newEpochStartTime = firstBlockOfNewEpoch ? await getBlockTimestampFromChain(firstBlockOfNewEpoch) : null;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.address) continue;
        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

        initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumberForNew, currentPhraseStartEpochForNew, newEpoch, currentTime, false);

        // Set epochStartTime
        if (phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[newEpoch]) {
            phraseMonitoringData[validatorKey][phraseKey].epochs[newEpoch].epochStartTime = newEpochStartTime;
            if (newEpochStartTime) {
                logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Waktu mulai epoch tercatat ${newEpochStartTime}.`, 'EPOCH');
            } else {
                logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Gagal mendapatkan waktu mulai epoch.`, 'WARN');
            }
        }
    }
}

// PERBAIKAN: Logika untuk menggunakan nomor frasa
async function epochAndPhraseManagementLoopForApiHelper() {
    try {
        const currentNetworkEpoch = await getCurrentNetworkEpochFromPolkadotApi();
        if (currentNetworkEpoch === -1) {
            await logMessage("Gagal mendapatkan epoch jaringan, tidak dapat melanjutkan manajemen frasa/epoch API helper.", 'ERROR');
            epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
            return;
        }

        const calculatedCurrentPhraseNumber = calculatePhraseNumber(currentNetworkEpoch);
        let calculatedCurrentPhraseStartEpoch = getStartEpochForPhrase(calculatedCurrentPhraseNumber);

        if (calculatedCurrentPhraseNumber < 1) { // Belum masuk frasa pertama
            if (currentPhraseNumber === -1) { // Hanya log jika ini pertama kali
                await logMessage(`Epoch jaringan (${currentNetworkEpoch}) lebih awal dari frasa pertama (${FIRST_EVER_PHRASE_START_EPOCH}). Menunggu.`, 'PHRASE');
            }
            lastKnownNetworkEpoch = currentNetworkEpoch; // Tetap update lastKnownNetworkEpoch
            epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
            return;
        }

        const calculatedCurrentPhraseEndEpoch = calculatedCurrentPhraseStartEpoch + PHRASE_DURATION_EPOCHS - 1;

        // Deteksi perubahan frasa
        if (currentPhraseNumber !== -1 && currentPhraseNumber !== calculatedCurrentPhraseNumber) {
            await logMessage(`--- Frasa Baru API Helper Terdeteksi (Dari Frasa ${currentPhraseNumber} ke Frasa ${calculatedCurrentPhraseNumber}) ---`, 'PHRASE');
            // Data frasa sebelumnya sudah disimpan. Muat data untuk frasa baru.
            const loadedDataForNewPhrase = await loadPhraseMonitoringData(calculatedCurrentPhraseNumber);
            // Gabungkan atau ganti phraseMonitoringData dengan data yang dimuat, hati-hati agar tidak menghapus data validator lain
            for (const validatorKey in loadedDataForNewPhrase) {
                if (!phraseMonitoringData[validatorKey]) phraseMonitoringData[validatorKey] = {};
                phraseMonitoringData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`] = loadedDataForNewPhrase[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`];
            }
        }

        // Inisialisasi atau update data untuk frasa saat ini
        if (currentPhraseNumber !== calculatedCurrentPhraseNumber || (Object.keys(phraseMonitoringData).length === 0 && calculatedCurrentPhraseNumber >= 1)) {
            if (Object.keys(phraseMonitoringData).length === 0 && calculatedCurrentPhraseNumber >= 1) {
                const loadedInitialData = await loadPhraseMonitoringData(calculatedCurrentPhraseNumber);
                // Inisialisasi phraseMonitoringData dengan struktur yang benar
                for (const validatorKey in loadedInitialData) {
                    if (!phraseMonitoringData[validatorKey]) phraseMonitoringData[validatorKey] = {};
                    phraseMonitoringData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`] = loadedInitialData[validatorKey][`phrase_${calculatedCurrentPhraseNumber}`];
                }
            }

            const allowlist = await loadAllowlist();
            const currentTime = Date.now();
            for (const phoneKey of Object.keys(allowlist)) {
                const serverConfig = allowlist[phoneKey];
                if (!serverConfig || !serverConfig.address) continue;
                const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

                // Inisialisasi atau tandai epoch yang terlewat dalam frasa saat ini
                if (calculatedCurrentPhraseStartEpoch <= currentNetworkEpoch) {
                    for (let epochInCurrentPhrase = calculatedCurrentPhraseStartEpoch; epochInCurrentPhrase < currentNetworkEpoch; epochInCurrentPhrase++) {
                        if (epochInCurrentPhrase <= calculatedCurrentPhraseEndEpoch) {
                            const phraseKey = `phrase_${calculatedCurrentPhraseNumber}`;
                            const existingEpochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[epochInCurrentPhrase];
                            if (!existingEpochData || !['PASS_API_HELPER', 'FAIL_API_HELPER', 'SKIP_HISTORIS'].includes(existingEpochData.status)) {
                                initializeValidatorPhraseEpochDataForApiHelper(validatorKey, calculatedCurrentPhraseNumber, calculatedCurrentPhraseStartEpoch, epochInCurrentPhrase, currentTime, true);
                            }
                        }
                    }
                }
                // Pastikan epoch jaringan saat ini diinisialisasi sebagai BERJALAN
                if (currentNetworkEpoch >= calculatedCurrentPhraseStartEpoch && currentNetworkEpoch <= calculatedCurrentPhraseEndEpoch) {
                    initializeValidatorPhraseEpochDataForApiHelper(validatorKey, calculatedCurrentPhraseNumber, calculatedCurrentPhraseStartEpoch, currentNetworkEpoch, currentTime, false);
                }
            }
            // Setel phraseStartTime jika ini awal frasa dan epoch jaringan adalah epoch awal frasa
            if (currentNetworkEpoch === calculatedCurrentPhraseStartEpoch) {
                const firstBlockCurrentPhrase = await getFirstBlockOfEpoch(calculatedCurrentPhraseStartEpoch);
                const phraseStartTime = firstBlockCurrentPhrase ? await getBlockTimestampFromChain(firstBlockCurrentPhrase) : null;
                const allowlistForPhraseStart = await loadAllowlist();
                for (const phoneKey of Object.keys(allowlistForPhraseStart)) {
                    const serverConfig = allowlistForPhraseStart[phoneKey];
                    if (!serverConfig || !serverConfig.address) continue;
                    const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);
                    const phraseKey = `phrase_${calculatedCurrentPhraseNumber}`;
                    if (phraseMonitoringData[validatorKey]?.[phraseKey]) {
                        phraseMonitoringData[validatorKey][phraseKey].phraseStartTime = phraseStartTime;
                        if (phraseStartTime) logMessage(`Frasa ${calculatedCurrentPhraseNumber} untuk ${validatorKey} dimulai pada ${phraseStartTime}.`, 'PHRASE');
                    }
                }
            }
        }
        currentPhraseNumber = calculatedCurrentPhraseNumber;
        currentPhraseStartEpochForMonitoring = calculatedCurrentPhraseStartEpoch;


        // Deteksi perubahan epoch
        if (lastKnownNetworkEpoch !== -1 && currentNetworkEpoch > lastKnownNetworkEpoch) {
            for (let epochJustFinished = lastKnownNetworkEpoch; epochJustFinished < currentNetworkEpoch; epochJustFinished++) {
                const phraseNumberOfFinishedEpoch = calculatePhraseNumber(epochJustFinished);
                if (phraseNumberOfFinishedEpoch >= 1) { // Hanya proses jika epoch berada dalam frasa yang valid
                    await handleApiHelperEpochEnd(epochJustFinished, phraseNumberOfFinishedEpoch);
                }
            }
            // Pastikan epoch baru dimulai dalam konteks frasa yang benar
            if (currentNetworkEpoch >= currentPhraseStartEpochForMonitoring && currentNetworkEpoch <= (currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1)) {
                await handleApiHelperNewEpochStart(currentNetworkEpoch, currentPhraseNumber, currentPhraseStartEpochForMonitoring);
            }
        } else if (lastKnownNetworkEpoch === -1 && currentNetworkEpoch !== -1 && currentPhraseNumber !== -1) {
            if (currentNetworkEpoch >= currentPhraseStartEpochForMonitoring && currentNetworkEpoch <= (currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1)) {
                await handleApiHelperNewEpochStart(currentNetworkEpoch, currentPhraseNumber, currentPhraseStartEpochForMonitoring);
            }
        }
        lastKnownNetworkEpoch = currentNetworkEpoch;

    } catch (error) {
        await logMessage(`Error dalam epochAndPhraseManagementLoopForApiHelper: ${error.message} ${error.stack || ''}`, 'ERROR');
    } finally {
        epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
    }
}

// PERBAIKAN: Menggunakan phraseKey
async function checkApiHelperStatusForAllNodes() {
    await logMessage('Memulai siklus pengecekan status API helper...', 'API_HELPER');
    const allowlist = await loadAllowlist();
    const currentTime = Date.now();

    if (currentPhraseNumber === -1 || lastKnownNetworkEpoch === -1) {
        await logMessage("Epoch/frasa jaringan belum diketahui. Pengecekan status API helper ditunda.", 'WARN');
        return;
    }
    const phraseKey = `phrase_${currentPhraseNumber}`;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.ip || !serverConfig.port || !serverConfig.name || !serverConfig.address) {
            await logMessage(`Konfigurasi tidak lengkap untuk entri dengan kunci telepon ${phoneKey}. Melewati.`, 'WARN');
            continue;
        }

        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);
        initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumber, currentPhraseStartEpochForMonitoring, lastKnownNetworkEpoch, currentTime, false);

        const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[lastKnownNetworkEpoch];

        if (!epochData || epochData.status !== 'BERJALAN') {
            continue;
        }

        let currentApiHelperIsConsideredActive = true;
        let apiHelperStatusStringForLog = "Active";

        try {
            const response = await axios.get(`http://${serverConfig.ip}:${serverConfig.port}/cek`, { timeout: 10000 });
            const data = response.data;

            if (!data || !data.status || typeof data.status.result === 'undefined') {
                apiHelperStatusStringForLog = "InvalidResponse";
                currentApiHelperIsConsideredActive = false;
                await logMessage(`API Helper ${serverConfig.name}: Respons tidak valid.`, 'API_HELPER');
            } else {
                apiHelperStatusStringForLog = typeof data.status.result === 'object' && data.status.result.Active ? "Active" : data.status.result;
                if (apiHelperStatusStringForLog !== "Active") {
                    currentApiHelperIsConsideredActive = false;
                    await logMessage(`API Helper ${serverConfig.name}: Status = ${apiHelperStatusStringForLog}.`, 'API_HELPER');
                }
            }
        } catch (error) {
            apiHelperStatusStringForLog = "ErrorConnectionToApiHelper";
            currentApiHelperIsConsideredActive = false;
            if (error.isAxiosError && (!error.response || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code))) {
                await logMessage(`API Helper ${serverConfig.name}: Gagal terhubung (${error.code || error.message}).`, 'ERROR');
            } else {
                await logMessage(`API Helper ${serverConfig.name}: Error (${error.message}).`, 'ERROR');
            }
        }

        if (epochData.lastApiHelperState === 'AKTIF_API' && !currentApiHelperIsConsideredActive) {
            await logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Transisi API Helper AKTIF -> TIDAK AKTIF (Status: ${apiHelperStatusStringForLog})`, 'EPOCH');
            updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
            epochData.lastApiHelperState = 'TIDAK_AKTIF_API';
        } else if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API' && currentApiHelperIsConsideredActive) {
            await logMessage(`Validator ${validatorKey}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Transisi API Helper TIDAK AKTIF -> AKTIF`, 'EPOCH');
            updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
            epochData.lastApiHelperState = 'AKTIF_API';
        } else if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API' && !currentApiHelperIsConsideredActive) {
            updateApiHelperInactiveDuration(validatorKey, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
        } else if (epochData.lastApiHelperState === 'AKTIF_API' && currentApiHelperIsConsideredActive) {
            epochData.lastApiHelperStateChangeTimestamp = currentTime; // Tetap update timestamp jika masih aktif
        }
    }

    if (Object.keys(phraseMonitoringData).length > 0 && currentPhraseNumber !== -1) {
        await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
    }
    await logMessage('Siklus pengecekan status API helper selesai.', 'API_HELPER');
}

async function initializeAndStartMonitoring() {
    await logMessage('Memulai API Helper Monitor...', 'SYSTEM');
    try {
        await fs.mkdir(PHRASE_DATA_DIR, { recursive: true });
    } catch (err) {
        console.error(`FATAL: Gagal membuat direktori yang diperlukan: ${err.message}`);
        process.exit(1);
    }

    const initialNetworkEpoch = await getCurrentNetworkEpochFromPolkadotApi();
    if (initialNetworkEpoch === -1) {
        await logMessage("Gagal mendapatkan epoch jaringan pada inisialisasi. Penjadwalan ulang inisialisasi.", 'ERROR');
        setTimeout(initializeAndStartMonitoring, EPOCH_CHECK_INTERVAL_MS);
        return;
    }
    lastKnownNetworkEpoch = initialNetworkEpoch; // Set lastKnownNetworkEpoch di sini

    currentPhraseNumber = calculatePhraseNumber(initialNetworkEpoch);
    if (currentPhraseNumber < 1) { // Jika belum masuk frasa pertama
        currentPhraseStartEpochForMonitoring = FIRST_EVER_PHRASE_START_EPOCH; // Targetkan frasa pertama
        currentPhraseNumber = 1; // Anggap kita akan mulai dengan frasa 1
        phraseMonitoringData = {}; // Akan diisi saat frasa benar-benar dimulai
        await logMessage(`Epoch jaringan (${initialNetworkEpoch}) lebih awal dari frasa pertama (${FIRST_EVER_PHRASE_START_EPOCH}). Menunggu frasa pertama (Frasa ${currentPhraseNumber}).`, 'PHRASE');
    } else {
        currentPhraseStartEpochForMonitoring = getStartEpochForPhrase(currentPhraseNumber);
        // Muat data untuk frasa saat ini
        const loadedData = await loadPhraseMonitoringData(currentPhraseNumber);
        // Inisialisasi phraseMonitoringData dengan data yang dimuat, atau objek kosong jika tidak ada
        phraseMonitoringData = loadedData || {};
    }

    const allowlist = await loadAllowlist();
    const currentTime = Date.now();
    const currentCalculatedPhraseEndEpoch = currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1;

    for (const phoneKey of Object.keys(allowlist)) {
        const serverConfig = allowlist[phoneKey];
        if (!serverConfig || !serverConfig.address) continue;
        const validatorKey = getValidatorKeyFromAllowlistEntry(serverConfig);

        // Pastikan struktur data frasa ada untuk validator ini
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
        // Setel phraseStartTime jika ini awal frasa dan epoch jaringan adalah epoch awal frasa
        if (initialNetworkEpoch === currentPhraseStartEpochForMonitoring && !phraseMonitoringData[validatorKey][phraseKey].phraseStartTime) {
            const firstBlockCurrentPhrase = await getFirstBlockOfEpoch(currentPhraseStartEpochForMonitoring);
            phraseMonitoringData[validatorKey][phraseKey].phraseStartTime = firstBlockCurrentPhrase ? await getBlockTimestampFromChain(firstBlockCurrentPhrase) : null;
            if (phraseMonitoringData[validatorKey][phraseKey].phraseStartTime) logMessage(`Frasa ${currentPhraseNumber} untuk ${validatorKey} dimulai pada ${phraseMonitoringData[validatorKey][phraseKey].phraseStartTime}.`, 'PHRASE');
        }


        // Hanya proses inisialisasi SKIP jika frasa saat ini sudah dimulai atau sedang berjalan
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

        // Inisialisasi epoch jaringan saat ini sebagai BERJALAN, jika dalam frasa yang dipantau
        if (initialNetworkEpoch >= currentPhraseStartEpochForMonitoring && initialNetworkEpoch <= currentCalculatedPhraseEndEpoch) {
            initializeValidatorPhraseEpochDataForApiHelper(validatorKey, currentPhraseNumber, currentPhraseStartEpochForMonitoring, initialNetworkEpoch, currentTime, false);
            // Set epochStartTime untuk epoch yang baru dimulai
            const epochData = phraseMonitoringData[validatorKey]?.[phraseKey]?.epochs?.[initialNetworkEpoch];
            if (epochData && !epochData.epochStartTime) {
                const firstBlockCurrentEpoch = await getFirstBlockOfEpoch(initialNetworkEpoch);
                epochData.epochStartTime = firstBlockCurrentEpoch ? await getBlockTimestampFromChain(firstBlockCurrentEpoch) : null;
                if (epochData.epochStartTime) logMessage(`Epoch ${initialNetworkEpoch} (Frasa ${currentPhraseNumber}) untuk ${validatorKey} dimulai pada ${epochData.epochStartTime}.`, 'EPOCH');
            }
        }
    }

    if (currentPhraseNumber !== -1 && Object.keys(phraseMonitoringData).length > 0) {
        await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
    }

    epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, 0);
    apiHelperCheckIntervalId = setTimeout(checkApiHelperStatusForAllNodes, 5000);

    await logMessage(`Pengecekan status API helper dijadwalkan setiap ${CHECK_INTERVAL_MS / 60000} menit.`, 'SYSTEM');
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

    if (polkadotApi) {
        await polkadotApi.disconnect().catch(e => logMessage(`Error saat disconnect API global pada SIGINT: ${e.message}`, 'ERROR'));
    }

    const currentTimeForExit = Date.now();
    if (lastKnownNetworkEpoch !== -1 && currentPhraseNumber !== -1) {
        const allowlist = await loadAllowlist().catch(() => ({}));
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

