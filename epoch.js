// api_helper_monitor.js
const { ApiPromise, WsProvider } = require('@polkadot/api');
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk'); // Chalk mungkin perlu diinstal: npm install chalk
const express = require('express'); // Menambahkan express untuk web server

// --- Konfigurasi Path & Dasar ---
const CONFIG_DIR = path.join('config');
// ALLOWLIST_PATH dihapus, karena tidak lagi digunakan
const LOG_FILE_PATH = path.join('logs', 'api_helper_monitor.log');
const PHRASE_DATA_DIR = path.join('api_helper_phrase_data');
const PHRASE_METADATA_DIR = path.join('phrase_metadata_data'); // Direktori untuk metadata frasa global
const GLOBAL_CONSTANTS_CONFIG_PATH = path.join(CONFIG_DIR, 'global_constants.json'); // Path untuk konstanta global

const CHECK_INTERVAL_MS = 1 * 60 * 1000; // Diubah menjadi 1 menit
const EPOCH_CHECK_INTERVAL_MS = 60 * 1000; // Interval untuk memeriksa epoch jaringan & progressnya
let FIRST_EVER_PHRASE_START_EPOCH = 5450; // Akan dimuat dari config
let PHRASE_DURATION_EPOCHS = 84; // Akan dimuat dari config
let EPOCH_FAIL_THRESHOLD_SECONDS = 2 * 60 * 60; // Akan dimuat dari config
const GLOBAL_RPC_ENDPOINT = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io';
let AVG_BLOCK_TIME_SECONDS = 6; // Akan dimuat dari config

// --- Variabel State Global ---
let phraseMonitoringData = {}; // Data monitoring per validator, per epoch
let currentPhraseMetadata = {}; // Metadata frasa aktif saat ini (misal: phraseNumber, phraseStartEpoch, phraseStartTime)
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
  percentage: 0,
  currentAbsoluteBlock: 0,
  currentEpochIndexFromProgress: -1,
  error: null,
};
let BOT_START_TIME_ISO = null;

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Asumsikan folder 'views' di direktori yang sama

// --- Fungsi Utilitas ---

/**
 * Mencatat pesan ke konsol dan file log dengan timestamp dan tipe.
 * @param {string} message Pesan yang akan dicatat.
 * @param {string} type Tipe pesan (INFO, WARN, ERROR, SUCCESS, PHRASE, EPOCH, API_HELPER, SYSTEM).
 */
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

// loadAllowlist dihapus sepenuhnya

/**
 * Memuat data monitoring validator untuk frasa tertentu dari file JSON.
 * @param {number} phraseNumber Nomor frasa.
 * @returns {Promise<object>} Data monitoring untuk frasa tersebut.
 */
async function loadPhraseMonitoringData(phraseNumber) {
  if (typeof phraseNumber !== 'number' || phraseNumber < 1) {
    await logMessage(`Gagal memuat data frasa: nomor frasa tidak valid (${phraseNumber}). Mengembalikan data kosong.`, 'WARN');
    return {};
  }
  const filePath = path.join(PHRASE_DATA_DIR, `api_helper_phrase_${phraseNumber}_data.json`);
  try {
    await fs.access(filePath);
    const data = await fs.readFile(filePath, 'utf8');
    let loadedData = JSON.parse(data);
    // Hapus metadata frasa jika ada (dari versi lama)
    for (const validatorAddress in loadedData) {
      const phraseData = loadedData[validatorAddress][`phrase_${phraseNumber}`];
      if (phraseData) {
        if (phraseData.phraseStartEpoch) delete phraseData.phraseStartEpoch;
        if (phraseData.phraseEndEpoch) delete phraseData.phraseEndEpoch;
        if (phraseData.phraseStartTime) delete phraseData.phraseStartTime;
        // Migrasi field lama jika ada
        if (phraseData.epochs) {
          for (const epochNum in phraseData.epochs) {
            const epochData = phraseData.epochs[epochNum];
            if (typeof epochData.totalRpcInactiveSeconds !== 'undefined') {
              epochData.totalApiHelperInactiveSeconds = epochData.totalRpcInactiveSeconds;
              delete epochData.totalRpcInactiveSeconds;
            }
            if (epochData.status === 'PASS_RPC_UPTIME') epochData.status = 'PASS_API_HELPER';
            else if (epochData.status === 'FAIL_RPC_UPTIME') epochData.status = 'FAIL_API_HELPER';
            if (typeof epochData.lastRpcState !== 'undefined') {
              epochData.lastApiHelperState = epochData.lastRpcState;
              delete epochData.lastRpcState;
            }
          }
        }
      }
    }
    await logMessage(`Memuat data pemantauan validator yang ada untuk frasa ${phraseNumber}.`, 'PHRASE');
    return loadedData;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await logMessage(`Tidak ada data pemantauan validator tersimpan untuk frasa ${phraseNumber}. Memulai data baru.`, 'WARN');
    } else {
      await logMessage(`Gagal memuat data pemantauan validator untuk frasa ${phraseNumber}: ${error.message}. Memulai data baru.`, 'ERROR');
    }
    return {};
  }
}

/**
 * Menyimpan data monitoring validator untuk frasa tertentu ke file JSON.
 * @param {number} phraseNumber Nomor frasa.
 * @param {object} dataToSave Data yang akan disimpan.
 */
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
        // Hapus metadata frasa jika ada (dari versi lama)
        const currentValidatorPhraseData = { ...dataToSave[validatorKey][`phrase_${phraseNumber}`] };
        delete currentValidatorPhraseData.phraseStartEpoch;
        delete currentValidatorPhraseData.phraseEndEpoch;
        delete currentValidatorPhraseData.phraseStartTime;
        relevantDataForPhrase[validatorKey][`phrase_${phraseNumber}`] = currentValidatorPhraseData;
      }
    }
    if (Object.keys(relevantDataForPhrase).length > 0) {
      await fs.writeFile(filePath, JSON.stringify(relevantDataForPhrase, null, 2));
      await logMessage(`Data pemantauan validator frasa ${phraseNumber} disimpan.`, 'PHRASE');
    } else {
      await logMessage(`Tidak ada data relevan untuk disimpan untuk frasa ${phraseNumber}. Melewati penyimpanan file.`, 'INFO');
    }
  } catch (error) {
    await logMessage(`Gagal menyimpan data pemantauan validator frasa ${phraseNumber}: ${error.message}`, 'ERROR');
  }
}

/**
 * Memuat metadata global untuk frasa tertentu dari file JSON.
 * @param {number} phraseNumber Nomor frasa.
 * @returns {Promise<object>} Metadata frasa global.
 */
async function loadPhraseMetadata(phraseNumber) {
  const filePath = path.join(PHRASE_METADATA_DIR, `phrase_${phraseNumber}_metadata.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await logMessage(`Tidak ada metadata tersimpan untuk frasa ${phraseNumber}.`, 'INFO');
    } else {
      await logMessage(`Gagal memuat metadata frasa ${phraseNumber}: ${error.message}.`, 'ERROR');
    }
    return {};
  }
}

/**
 * Menyimpan metadata global frasa ke file JSON.
 * @param {object} metadata Metadata frasa.
 */
async function savePhraseMetadata(metadata) {
  if (!metadata || typeof metadata.phraseNumber !== 'number' || metadata.phraseNumber < 1) {
    await logMessage(`Gagal menyimpan metadata frasa: nomor frasa tidak valid atau objek metadata kosong.`, 'ERROR');
    return;
  }
  const filePath = path.join(PHRASE_METADATA_DIR, `phrase_${metadata.phraseNumber}_metadata.json`);
  try {
    await fs.writeFile(filePath, JSON.stringify(metadata, null, 2));
    await logMessage(`Metadata frasa ${metadata.phraseNumber} disimpan.`, 'PHRASE');
  } catch (error) {
    await logMessage(`Gagal menyimpan metadata frasa ${metadata.phraseNumber}: ${error.message}`, 'ERROR');
  }
}

/**
 * Menginisialisasi atau menghubungkan kembali ke API Polkadot global.
 * @returns {Promise<ApiPromise|null>} Instance ApiPromise atau null jika gagal.
 */
async function initializeGlobalPolkadotApi() {
  if (polkadotApi && polkadotApi.isConnected) {
    try {
      await polkadotApi.rpc.system.health();
      return polkadotApi;
    } catch (e) {
      await logMessage(`Koneksi API tidak responsif: ${e.message}. Mencoba menghubungkan kembali.`, "WARN");
      if (polkadotApi) {
        try { await polkadotApi.disconnect(); } catch (disconnErr) { /* ignore */ }
      }
      polkadotApi = null;
    }
  }

  await logMessage('Mencoba terhubung ke API Polkadot global...', 'SYSTEM');
  const provider = new WsProvider(GLOBAL_RPC_ENDPOINT, false);

  provider.on('error', (err) => {
    logMessage(`WebSocket connection error: ${err.message}`, "ERROR");
  });
  provider.on('disconnected', () => {
    logMessage('WebSocket connection disconnected. Akan mencoba menghubungkan kembali pada siklus berikutnya.', "WARN");
    polkadotApi = null;
  });

  try {
    await provider.connect();
    polkadotApi = await ApiPromise.create({ provider });
    await polkadotApi.isReady;
    await logMessage('Berhasil terhubung ke API Polkadot global.', 'SUCCESS');
    return polkadotApi;
  } catch (error) {
    await logMessage(`Gagal terhubung ke API Polkadot global: ${error.message}`, 'ERROR');
    if (polkadotApi) await polkadotApi.disconnect().catch(e => logMessage(`Error saat disconnect API global: ${e.message}`, 'ERROR'));
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

// updateCurrentEpochProgressDetails diperbarui
async function updateCurrentEpochProgressDetails() {
  const api = await initializeGlobalPolkadotApi();
  if (!api) {
    await logMessage("API Polkadot Global tidak terinisialisasi, tidak dapat update progress epoch.", "WARN");
    currentEpochProgressDetails = { estimatedEpochCompletionTime: null, nextEpochETAFormatted: 'N/A', currentBlockInEpoch: 0, totalBlocksInEpoch: 0, percentage: 0, currentEpochIndexFromProgress: lastKnownNetworkEpoch, currentAbsoluteBlock: 0, error: "API disconnected" };
    return;
  }
  try {
    const sessionInfo = await api.derive.session.progress();
    const blockHeader = await api.rpc.chain.getHeader();
    const currentAbsoluteBlock = blockHeader.number.toNumber();

    const totalBlocksInEpoch = sessionInfo.sessionLength.toNumber();
    const currentBlockInEpoch = sessionInfo.sessionProgress.toNumber();
    const remainingBlocks = totalBlocksInEpoch > 0 ? totalBlocksInEpoch - currentBlockInEpoch : 0;
    const percentage = totalBlocksInEpoch > 0 ? (currentBlockInEpoch / totalBlocksInEpoch) * 100 : 0;
    const nextEpochInFormatted = formatBlocksToTime(remainingBlocks);
    const estimatedCompletionTimestampMs = Date.now() + (remainingBlocks * AVG_BLOCK_TIME_SECONDS * 1000);

    currentEpochProgressDetails = {
      currentEpochIndexFromProgress: sessionInfo.currentIndex.toNumber(),
      totalBlocksInEpoch,
      currentBlockInEpoch,
      remainingBlocks,
      percentage: parseFloat(percentage.toFixed(2)),
      nextEpochETAFormatted: nextEpochInFormatted,
      estimatedEpochCompletionTime: estimatedCompletionTimestampMs ? new Date(estimatedCompletionTimestampMs).toISOString() : null,
      currentAbsoluteBlock: currentAbsoluteBlock,
      error: null,
    };
  } catch (error) {
    await logMessage(`Error mengambil data progress epoch: ${error.message}`, 'ERROR');
    currentEpochProgressDetails = {
      currentEpochIndexFromProgress: lastKnownNetworkEpoch,
      totalBlocksInEpoch: 0, currentBlockInEpoch: 0, remainingBlocks: 0, percentage: 0,
      nextEpochETAFormatted: 'N/A', estimatedEpochCompletionTime: null,
      currentAbsoluteBlock: 0,
      error: error.message,
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

// getEpochStartTimestamp diubah untuk mengandalkan estimasi saja, tanpa mencoba fetch dari blockchain
async function getEpochStartTimestamp(epochNum) {
  let timestamp = null;
  const currentTime = Date.now();
  const fixedEpochDurationMs = 4 * 60 * 60 * 1000; // 4 jam dalam milidetik, sebagai standar durasi epoch

  // Pastikan currentEpochProgressDetails valid untuk estimasi
  if (!currentEpochProgressDetails.estimatedEpochCompletionTime ||
    currentEpochProgressDetails.currentEpochIndexFromProgress === -1) {
    await logMessage(`getEpochStartTimestamp: currentEpochProgressDetails tidak lengkap, tidak dapat mengestimasi waktu mulai untuk epoch ${epochNum}.`, 'WARN');
    return null;
  }

  const currentEpochOnChain = currentEpochProgressDetails.currentEpochIndexFromProgress;
  const currentEpochCompletionTimeMs = new Date(currentEpochProgressDetails.estimatedEpochCompletionTime).getTime();

  // Prioritas 1: Jika ini adalah epoch yang sedang berjalan (currentEpochOnChain),
  // estimasi menggunakan estimatedEpochCompletionTime - 4 jam (sesuai permintaan spesifik).
  if (epochNum === currentEpochOnChain) {
    const estimatedStartTimeMs = currentEpochCompletionTimeMs - fixedEpochDurationMs;

    if (!isNaN(estimatedStartTimeMs) && estimatedStartTimeMs < currentTime + (5 * 60 * 1000)) {
      timestamp = new Date(estimatedStartTimeMs).toISOString();
      await logMessage(`Epoch ${epochNum}: Waktu mulai diestimasi untuk epoch AKTIF (Estimated Completion Time - 4 jam). Estimasi: ${timestamp}`, 'INFO');
      return timestamp;
    } else {
      await logMessage(`Epoch ${epochNum}: Estimasi Completion Time - 4 jam tidak valid atau di masa depan.`, 'WARN');
    }
  }

  // Prioritas 2: Untuk epoch historis atau mendatang, gunakan ekstrapolasi umum dari epoch yang sedang berjalan.
  if (timestamp === null) {
    const actualEpochDurationSeconds = (currentEpochProgressDetails.totalBlocksInEpoch && currentEpochProgressDetails.totalBlocksInEpoch > 0) ?
      (currentEpochProgressDetails.totalBlocksInEpoch * AVG_BLOCK_TIME_SECONDS) :
      (4 * 60 * 60); // Fallback: 4 hours in seconds (standard epoch duration)

    const avgEpochDurationMs = actualEpochDurationSeconds * 1000;
    const currentEpochStartTimeMs = currentEpochCompletionTimeMs - (currentEpochProgressDetails.remainingBlocks * AVG_BLOCK_TIME_SECONDS * 1000);

    const epochsDiff = currentEpochOnChain - epochNum;
    const estimatedStartTimeMs = currentEpochStartTimeMs - (epochsDiff * avgEpochDurationMs);

    if (!isNaN(estimatedStartTimeMs) &&
      estimatedStartTimeMs < currentTime + (2 * avgEpochDurationMs) &&
      estimatedStartTimeMs > currentTime - (PHRASE_DURATION_EPOCHS * avgEpochDurationMs * 2)) {
      timestamp = new Date(estimatedStartTimeMs).toISOString();
      await logMessage(`Epoch ${epochNum}: Waktu mulai diestimasi dari ekstrapolasi umum. Estimasi: ${timestamp}`, 'INFO');
    } else {
      await logMessage(`Epoch ${epochNum}: Estimasi waktu mulai ekstrapolasi umum tidak valid atau terlalu jauh.`, 'WARN');
    }
  }
  return timestamp;
}


// initializeValidatorPhraseEpochData diubah
function initializeValidatorPhraseEpochData(validatorAddress, phraseNumber, epochToMonitor, currentTime) {
  const phraseKey = `phrase_${phraseNumber}`;
  if (!validatorAddress || typeof phraseNumber !== 'number' || phraseNumber < 1 || typeof epochToMonitor !== 'number') {
    logMessage(`Gagal inisialisasi data: parameter tidak valid (validatorAddress: ${validatorAddress}, phraseNumber: ${phraseNumber}, epochToMonitor: ${epochToMonitor})`, 'ERROR');
    return;
  }
  if (!phraseMonitoringData[validatorAddress]) phraseMonitoringData[validatorAddress] = {};
  if (!phraseMonitoringData[validatorAddress][phraseKey]) {
    phraseMonitoringData[validatorAddress][phraseKey] = {
      epochs: {}
    };
    // logMessage(`Menginisialisasi struktur data frasa ${phraseNumber} untuk ${validatorAddress}.`, 'PHRASE');
  }
  const existingEpoch = phraseMonitoringData[validatorAddress][phraseKey].epochs[epochToMonitor];

  // Status awal selalu BERJALAN, karena kita hanya memantau epoch yang sedang berjalan atau yang baru saja selesai.
  // Epoch historis yang tidak dimonitor akan dibiarkan "tidak ada data"
  const initialStatus = 'BERJALAN';
  const initialLastState = 'TIDAK_DIKETAHUI'; // Akan diperbarui segera oleh checkApiHelperStatusForAllNodes

  const epochData = {
    totalApiHelperInactiveSeconds: existingEpoch?.totalApiHelperInactiveSeconds || 0,
    status: existingEpoch?.status || initialStatus, // Pertahankan status yang ada jika sudah ada
    epochStartTime: existingEpoch?.epochStartTime || null, // Akan diisi oleh getEpochStartTimestamp di handleNewEpochStart
    lastApiHelperState: existingEpoch?.lastApiHelperState || initialLastState,
    lastApiHelperStateChangeTimestamp: existingEpoch?.lastApiHelperStateChangeTimestamp || new Date(currentTime).toISOString(),
    failThresholdExceeded: existingEpoch?.failThresholdExceeded || false,
    firstMonitoredTimestamp: existingEpoch?.firstMonitoredTimestamp || new Date(currentTime).toISOString()
  };

  // Pastikan status di-set ke 'BERJALAN' jika belum final dan ini epoch saat ini
  if (!['PASS_API_HELPER', 'FAIL_API_HELPER', 'NO_DATA'].includes(epochData.status) && epochToMonitor === currentEpochProgressDetails.currentEpochIndexFromProgress) {
    epochData.status = 'BERJALAN';
  } else if (epochToMonitor < currentEpochProgressDetails.currentEpochIndexFromProgress && !['PASS_API_HELPER', 'FAIL_API_HELPER', 'NO_DATA'].includes(epochData.status)) {
    // Jika ini epoch historis yang belum dievaluasi, set ke NO_DATA (default untuk yang tidak aktif dimonitor)
    epochData.status = 'NO_DATA';
  }


  phraseMonitoringData[validatorAddress][phraseKey].epochs[epochToMonitor] = epochData;
}

function updateApiHelperInactiveDuration(validatorAddress, phraseNumber, epoch, currentTime) {
  const phraseKey = `phrase_${phraseNumber}`;
  const epochData = phraseMonitoringData[validatorAddress]?.[phraseKey]?.epochs?.[epoch];
  if (!epochData || ['PASS_API_HELPER', 'FAIL_API_HELPER', 'NO_DATA'].includes(epochData.status) || !epochData.lastApiHelperStateChangeTimestamp) return;

  if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API') {
    const inactiveDuration = Math.round((currentTime - new Date(epochData.lastApiHelperStateChangeTimestamp).getTime()) / 1000);
    if (inactiveDuration > 0) {
      epochData.totalApiHelperInactiveSeconds += inactiveDuration;
      // logMessage(`Validator ${validatorAddress}, Frasa ${phraseNumber}, Epoch ${epoch}: +${inactiveDuration}s API helper tidak aktif. Total: ${epochData.totalApiHelperInactiveSeconds}s.`, 'API_HELPER');
    }
  }
  epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString();
}

async function handleApiHelperEpochEnd(finishedEpoch, phraseNumberForFinishedEpoch) {
  await logMessage(`--- Akhir Epoch ${finishedEpoch} Terdeteksi untuk Pemantauan API Helper (Frasa ${phraseNumberForFinishedEpoch}) ---`, 'EPOCH');
  const currentTime = Date.now();
  const phraseKey = `phrase_${phraseNumberForFinishedEpoch}`;

  // Perbarui currentEpochProgressDetails sebelum estimasi epochStartTime
  await updateCurrentEpochProgressDetails();

  // Ambil daftar semua validator yang dikenal bot (baik dari data yang sudah ada atau yang aktif di RPC)
  const api = await initializeGlobalPolkadotApi();
  let currentRpcActiveValidators = [];
  if (api) {
    try { currentRpcActiveValidators = (await api.query.session.validators()).map(v => v.toString()); }
    catch (e) { await logMessage(`Error mengambil validator aktif untuk handleApiHelperEpochEnd: ${e.message}`, 'ERROR'); }
  }
  const currentRpcActiveValidatorsSet = new Set(currentRpcActiveValidators);

  // Dapatkan semua validator yang pernah dipantau atau yang baru ditemukan aktif di RPC
  const allRelevantValidators = new Set([...Object.keys(phraseMonitoringData), ...Array.from(currentRpcActiveValidatorsSet)]);


  for (const validatorAddress of allRelevantValidators) {
    const phraseStruct = phraseMonitoringData[validatorAddress]?.[phraseKey];

    // Jika validator tidak memiliki data untuk epoch ini, abaikan (karena kita tidak mengisi historis)
    // KECUALI jika itu adalah epoch yang baru saja berakhir dan dia belum ada datanya, maka set NO_DATA
    if (!phraseStruct || !phraseStruct.epochs[finishedEpoch]) {
      if (finishedEpoch === lastKnownNetworkEpoch) { // Ini adalah epoch yang baru saja berakhir
        initializeValidatorPhraseEpochData(validatorAddress, phraseNumberForFinishedEpoch, finishedEpoch, currentTime);
        const epochDataNoData = phraseMonitoringData[validatorAddress]?.[phraseKey]?.epochs?.[finishedEpoch];
        if (epochDataNoData) epochDataNoData.status = 'NO_DATA';
        await logMessage(`VALIDATOR ${validatorAddress}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: Tidak ada data monitoring. Status diatur ke NO_DATA.`, 'EPOCH');
      }
      continue;
    }

    const epochData = phraseStruct.epochs[finishedEpoch];

    // Isi epochStartTime jika masih null (menggunakan estimasi)
    if (epochData.epochStartTime === null || epochData.epochStartTime === 'N/A') {
      const estimatedStartTime = await getEpochStartTimestamp(finishedEpoch);
      if (estimatedStartTime) {
        epochData.epochStartTime = estimatedStartTime;
        await logMessage(`Epoch ${finishedEpoch} for ${validatorAddress}: epochStartTime diisi dari estimasi.`, 'INFO');
      }
    }

    // Jangan proses ulang jika status sudah final (PASS, FAIL, NO_DATA)
    if (['PASS_API_HELPER', 'FAIL_API_HELPER', 'NO_DATA'].includes(epochData.status)) {
      await logMessage(`VALIDATOR ${validatorAddress}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: Status sudah final (${epochData.status}). Tidak dievaluasi ulang.`, 'INFO');
      continue;
    }

    // Akumulasi durasi tidak aktif terakhir jika masih TIDAK_AKTIF_API atau status BERJALAN
    if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API' || epochData.status === 'BERJALAN') {
      updateApiHelperInactiveDuration(validatorAddress, phraseNumberForFinishedEpoch, finishedEpoch, currentTime);
    }

    if (epochData.totalApiHelperInactiveSeconds > EPOCH_FAIL_THRESHOLD_SECONDS) {
      epochData.status = 'FAIL_API_HELPER';
      epochData.failThresholdExceeded = true;
      await logMessage(`VALIDATOR ${validatorAddress}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: STATUS = FAIL (Total tidak aktif: ${epochData.totalApiHelperInactiveSeconds} detik)`, 'EPOCH');
    } else {
      epochData.status = 'PASS_API_HELPER';
      await logMessage(`VALIDATOR ${validatorAddress}, Frasa ${phraseNumberForFinishedEpoch}, EPOCH ${finishedEpoch}: STATUS = PASS (Total tidak aktif: ${epochData.totalApiHelperInactiveSeconds} detik)`, 'EPOCH');
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

// handleApiHelperNewEpochStart diubah untuk mengambil validator aktif langsung dari RPC
async function handleApiHelperNewEpochStart(newEpoch, currentPhraseNumberForNew, currentPhraseStartEpochForNew) {
  await logMessage(`--- Awal Epoch Baru ${newEpoch} Terdeteksi untuk Pemantauan API Helper (Frasa ${currentPhraseNumberForNew}, mulai ${currentPhraseStartEpochForNew}) ---`, 'EPOCH');
  const currentTime = Date.now();
  const api = await initializeGlobalPolkadotApi();
  let currentRpcActiveValidators = [];
  if (api) {
    try {
      currentRpcActiveValidators = (await api.query.session.validators()).map(validator => validator.toString());
      await logMessage(`Ditemukan ${currentRpcActiveValidators.length} validator aktif di RPC untuk epoch ${newEpoch}.`, 'API_HELPER');
    } catch (rpcError) {
      await logMessage(`Error mengambil daftar validator aktif dari RPC: ${rpcError.message}.`, "ERROR");
    }
  }
  const currentRpcActiveValidatorsSet = new Set(currentRpcActiveValidators);
  const phraseKey = `phrase_${currentPhraseNumberForNew}`;

  const newEpochStartTime = await getEpochStartTimestamp(newEpoch); // Menggunakan fungsi estimasi/ambil waktu mulai epoch

  // Proses validator yang aktif di RPC
  for (const validatorAddress of currentRpcActiveValidatorsSet) {
    // Inisialisasi atau update data validator ini untuk epoch baru
    initializeValidatorPhraseEpochData(validatorAddress, currentPhraseNumberForNew, newEpoch, currentTime);
    const epochData = phraseMonitoringData[validatorAddress]?.[phraseKey]?.epochs?.[newEpoch];

    if (epochData) {
      // Set epochStartTime jika belum ada
      if (epochData.epochStartTime === null) {
        epochData.epochStartTime = newEpochStartTime;
        if (newEpochStartTime) await logMessage(`Validator ${validatorAddress}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Waktu mulai epoch tercatat ${newEpochStartTime}.`, 'EPOCH');
        else await logMessage(`Validator ${validatorAddress}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Gagal mendapatkan waktu mulai epoch, tetap N/A.`, 'WARN');
      }
      // Perbarui status aktif/tidak aktifnya berdasarkan RPC
      epochData.lastApiHelperState = 'AKTIF_API'; // Karena mereka aktif di RPC
      epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString();
    }
  }

  // Proses validator yang tidak aktif di RPC, tetapi mungkin sudah ada di data monitoring (berarti offline)
  const allMonitoredValidators = new Set(Object.keys(phraseMonitoringData));
  for (const validatorAddress of allMonitoredValidators) {
    if (!currentRpcActiveValidatorsSet.has(validatorAddress)) {
      // Validator ini dikenal tapi tidak aktif di RPC
      // Pastikan data epoch-nya ada untuk epoch baru, lalu set sebagai TIDAK_AKTIF_API
      initializeValidatorPhraseEpochData(validatorAddress, currentPhraseNumberForNew, newEpoch, currentTime);
      const epochData = phraseMonitoringData[validatorAddress]?.[phraseKey]?.epochs?.[newEpoch];
      if (epochData) {
        if (epochData.epochStartTime === null) { // Set epochStartTime jika belum ada
          epochData.epochStartTime = newEpochStartTime;
        }
        if (epochData.lastApiHelperState === 'AKTIF_API') { // Jika sebelumnya aktif, catat transisi
          updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumberForNew, newEpoch, currentTime); // Akumulasi waktu tidak aktif
          await logMessage(`Validator ${validatorAddress}, Frasa ${currentPhraseNumberForNew}, Epoch ${newEpoch}: Transisi API Helper AKTIF -> TIDAK AKTIF (Tidak ada di RPC aktif)`, 'API_HELPER');
        }
        epochData.lastApiHelperState = 'TIDAK_AKTIF_API';
        epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString();
      }
    }
  }

  // Catat waktu mulai frasa jika ini adalah epoch pertama dari frasa tersebut dan belum tercatat
  if (newEpoch === currentPhraseStartEpochForNew && currentPhraseMetadata.phraseStartTime !== newEpochStartTime) {
    currentPhraseMetadata.phraseNumber = currentPhraseNumberForNew;
    currentPhraseMetadata.phraseStartEpoch = currentPhraseStartEpochForNew;
    currentPhraseMetadata.phraseEndEpoch = currentPhraseStartEpochForNew + PHRASE_DURATION_EPOCHS - 1;
    currentPhraseMetadata.phraseStartTime = newEpochStartTime;
    await savePhraseMetadata(currentPhraseMetadata);
    await logMessage(`Frasa ${currentPhraseNumberForNew} dimulai pada ${newEpochStartTime}. Metadata frasa diperbarui.`, 'PHRASE');
  }

  if (Object.keys(phraseMonitoringData).length > 0 && currentPhraseNumberForNew >= 1) {
    await savePhraseMonitoringData(currentPhraseNumberForNew, phraseMonitoringData);
  }
}


// epochAndPhraseManagementLoopForApiHelper diubah untuk mengambil RPC validator aktif untuk handleApiHelperNewEpochStart
async function epochAndPhraseManagementLoopForApiHelper() {
  try {
    const currentNetworkEpoch = await getCurrentNetworkEpochFromPolkadotApi();
    if (currentNetworkEpoch === -1) {
      await logMessage("Gagal mendapatkan epoch jaringan, tidak dapat melanjutkan manajemen frasa/epoch API helper.", 'ERROR');
      epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
      return;
    }
    await updateCurrentEpochProgressDetails(); // Pastikan progress details mutakhir

    if (currentEpochProgressDetails.estimatedEpochCompletionTime) {
      logMessage(`Epoch ${currentEpochProgressDetails.currentEpochIndexFromProgress} berjalan. Estimasi selesai: ${new Date(currentEpochProgressDetails.estimatedEpochCompletionTime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}, ETA: ${currentEpochProgressDetails.nextEpochETAFormatted}`, 'EPOCH');
    }

    const effectiveCurrentEpoch = currentEpochProgressDetails.currentEpochIndexFromProgress; // Gunakan ini sebagai sumber kebenaran

    const calculatedCurrentPhraseNumber = calculatePhraseNumber(effectiveCurrentEpoch);
    const calculatedCurrentPhraseStartEpoch = getStartEpochForPhrase(calculatedCurrentPhraseNumber);
    const calculatedCurrentPhraseEndEpoch = calculatedCurrentPhraseStartEpoch + PHRASE_DURATION_EPOCHS - 1;

    if (calculatedCurrentPhraseNumber < 1) {
      if (currentPhraseNumber === -1) { // Hanya log sekali saat pertama kali
        await logMessage(`Epoch jaringan (${effectiveCurrentEpoch}) lebih awal dari frasa pertama (${FIRST_EVER_PHRASE_START_EPOCH}). Menunggu.`, 'PHRASE');
      }
      lastKnownNetworkEpoch = effectiveCurrentEpoch;
      epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
      return;
    }

    // Deteksi perubahan frasa atau inisialisasi awal
    if (currentPhraseNumber !== -1 && currentPhraseNumber !== calculatedCurrentPhraseNumber) {
      await logMessage(`--- Frasa Baru API Helper Terdeteksi (Dari Frasa ${currentPhraseNumber} ke Frasa ${calculatedCurrentPhraseNumber}) ---`, 'PHRASE');
      phraseMonitoringData = await loadPhraseMonitoringData(calculatedCurrentPhraseNumber); // Muat data untuk frasa baru
      await logMessage(`Memuat data untuk frasa baru ${calculatedCurrentPhraseNumber}.`, 'PHRASE');
    } else if (currentPhraseNumber === -1) { // Startup pertama kali
      phraseMonitoringData = await loadPhraseMonitoringData(calculatedCurrentPhraseNumber);
      await logMessage(`Inisialisasi bot pada frasa ${calculatedCurrentPhraseNumber}.`, 'PHRASE');
    }

    // Muat metadata frasa untuk frasa saat ini
    let loadedPhraseMetadata = await loadPhraseMetadata(calculatedCurrentPhraseNumber);
    if (Object.keys(loadedPhraseMetadata).length === 0) {
      currentPhraseMetadata = {
        phraseNumber: calculatedCurrentPhraseNumber,
        phraseStartEpoch: calculatedCurrentPhraseStartEpoch,
        phraseEndEpoch: calculatedCurrentPhraseEndEpoch,
        phraseStartTime: null // Akan diisi saat epoch awal frasa dimulai atau di handleApiHelperNewEpochStart
      };
      await savePhraseMetadata(currentPhraseMetadata);
    } else {
      currentPhraseMetadata = loadedPhraseMetadata;
    }

    currentPhraseNumber = calculatedCurrentPhraseNumber;
    currentPhraseStartEpochForMonitoring = calculatedCurrentPhraseStartEpoch;

    // Penanganan akhir epoch dan awal epoch baru
    if (lastKnownNetworkEpoch !== -1 && effectiveCurrentEpoch > lastKnownNetworkEpoch) {
      for (let epochJustFinished = lastKnownNetworkEpoch; epochJustFinished < effectiveCurrentEpoch; epochJustFinished++) {
        const phraseNumberOfFinishedEpoch = calculatePhraseNumber(epochJustFinished);
        if (phraseNumberOfFinishedEpoch >= 1) {
          const startEpochForFinishedPhrase = getStartEpochForPhrase(phraseNumberOfFinishedEpoch);
          const endEpochForFinishedPhrase = startEpochForFinishedPhrase + PHRASE_DURATION_EPOCHS - 1;
          if (epochJustFinished >= startEpochForFinishedPhrase && epochJustFinished <= endEpochForFinishedPhrase) {
            await handleApiHelperEpochEnd(epochJustFinished, phraseNumberOfFinishedEpoch);
          }
        }
      }
      // Panggil awal epoch baru untuk epoch saat ini
      await handleApiHelperNewEpochStart(effectiveCurrentEpoch, currentPhraseNumber, currentPhraseStartEpochForMonitoring);
    } else if (lastKnownNetworkEpoch === -1 && effectiveCurrentEpoch !== -1 && currentPhraseNumber !== -1) { // Kasus inisialisasi pertama
      await handleApiHelperNewEpochStart(effectiveCurrentEpoch, currentPhraseNumber, currentPhraseStartEpochForMonitoring);
    }
    lastKnownNetworkEpoch = effectiveCurrentEpoch;

  } catch (error) {
    await logMessage(`Error dalam epochAndPhraseManagementLoopForApiHelper: ${error.message} ${error.stack || ''}`, 'ERROR');
  } finally {
    epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, EPOCH_CHECK_INTERVAL_MS);
  }
}

// checkApiHelperStatusForAllNodes diubah untuk mengambil status validator langsung dari RPC
async function checkApiHelperStatusForAllNodes() {
  await logMessage('Memulai siklus pengecekan status API helper berdasarkan status RPC...', 'API_HELPER');
  const currentTime = Date.now();

  if (currentPhraseNumber === -1 || lastKnownNetworkEpoch === -1) {
    await logMessage("Epoch/frasa jaringan belum diketahui. Pengecekan status API helper ditunda.", 'WARN');
    return;
  }

  const api = await initializeGlobalPolkadotApi();
  let currentRpcActiveValidators = [];
  if (api) {
    try {
      currentRpcActiveValidators = (await api.query.session.validators()).map(validator => validator.toString());
      await logMessage(`Ditemukan ${currentRpcActiveValidators.length} validator aktif di RPC.`, 'API_HELPER');
    } catch (rpcError) {
      await logMessage(`Error mengambil daftar validator aktif dari RPC: ${rpcError.message}.`, "ERROR");
    }
  }
  const currentRpcActiveValidatorsSet = new Set(currentRpcActiveValidators);
  const phraseKey = `phrase_${currentPhraseNumber}`;

  // Kumpulkan semua validator yang dikenal bot (baik dari data yang sudah ada atau yang baru aktif di RPC)
  const allRelevantValidators = new Set([...Object.keys(phraseMonitoringData), ...Array.from(currentRpcActiveValidatorsSet)]);


  for (const validatorAddress of allRelevantValidators) {
    const isRpcActive = currentRpcActiveValidatorsSet.has(validatorAddress);
    const initialApiHelperState = isRpcActive ? 'AKTIF_API' : 'TIDAK_AKTIF_API';

    // Inisialisasi atau update data validator ini untuk epoch saat ini
    initializeValidatorPhraseEpochData(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
    const epochData = phraseMonitoringData[validatorAddress]?.[phraseKey]?.epochs?.[lastKnownNetworkEpoch];

    if (!epochData) { // Ini seharusnya tidak terjadi jika initializeValidatorPhraseEpochData dipanggil dengan benar
      await logMessage(`Data epoch tidak ditemukan setelah inisialisasi untuk ${validatorAddress} di epoch ${lastKnownNetworkEpoch}.`, 'ERROR');
      continue;
    }

    // Set epochStartTime jika masih null (menggunakan estimasi)
    if (epochData.epochStartTime === null) { // Atau check for 'N/A' if that's what's stored
      const estimatedStartTime = await getEpochStartTimestamp(lastKnownNetworkEpoch);
      if (estimatedStartTime) {
        epochData.epochStartTime = estimatedStartTime;
        await logMessage(`Epoch ${lastKnownNetworkEpoch} for ${validatorAddress}: epochStartTime diisi dari estimasi.`, 'INFO');
      }
    }


    // Perbarui status aktif/tidak aktifnya berdasarkan RPC
    const previousApiHelperState = epochData.lastApiHelperState;

    if (previousApiHelperState === 'AKTIF_API' && !isRpcActive) {
      await logMessage(`Validator ${validatorAddress}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Transisi AKTIF -> TIDAK AKTIF (Tidak ada di RPC aktif)`, 'API_HELPER');
      updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
      epochData.lastApiHelperState = 'TIDAK_AKTIF_API';
    } else if (previousApiHelperState === 'TIDAK_AKTIF_API' && isRpcActive) {
      await logMessage(`Validator ${validatorAddress}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Transisi TIDAK AKTIF -> AKTIF (Muncul di RPC aktif)`, 'API_HELPER');
      updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTime); // Akumulasi waktu tidak aktif
      epochData.lastApiHelperState = 'AKTIF_API';
    } else if (previousApiHelperState === 'TIDAK_AKTIF_API' && !isRpcActive) {
      // Tetap tidak aktif, update durasi
      updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
    } else if (previousApiHelperState === 'TIDAK_DIKETAHUI') { // Kasus inisialisasi awal epoch
      // ini seharusnya tidak lagi TIDAK_DIKETAHUI karena initializeValidatorPhraseEpochData sudah setting
      epochData.lastApiHelperState = initialApiHelperState;
      if (initialApiHelperState === 'TIDAK_AKTIF_API') {
        updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTime);
      }
      await logMessage(`Validator ${validatorAddress}, Frasa ${currentPhraseNumber}, Epoch ${lastKnownNetworkEpoch}: Status API Helper awal terdeteksi sebagai ${initialApiHelperState}.`, 'API_HELPER');
    }
    // Perbarui timestamp perubahan terakhir (atau timestamp pengecekan)
    epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString();
  }

  if (Object.keys(phraseMonitoringData).length > 0 && currentPhraseNumber !== -1) {
    await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
  } else {
    await logMessage(`Tidak ada data validator untuk disimpan untuk frasa ${currentPhraseNumber} setelah pengecekan status.`, 'INFO');
  }
  await logMessage('Siklus pengecekan status API helper berdasarkan status RPC selesai.', 'API_HELPER');
}

// Inisialisasi awal bot
async function initializeAndStartMonitoring() {
  BOT_START_TIME_ISO = new Date().toISOString();
  await logMessage('Memulai API Helper Monitor...', 'SYSTEM');
  try {
    // Pastikan direktori ada
    const dirsToCreate = [CONFIG_DIR, PHRASE_DATA_DIR, PHRASE_METADATA_DIR];
    for (const dir of dirsToCreate) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await logMessage(`Direktori '${dir}' berhasil dibuat atau sudah ada.`, 'SYSTEM');
      } catch (dirErr) {
        await logMessage(`FATAL: Gagal membuat direktori '${dir}': ${dirErr.message}`, 'ERROR');
        process.exit(1);
      }
    }


    // Muat konstanta global dari file config
    try {
      const configContent = await fs.readFile(GLOBAL_CONSTANTS_CONFIG_PATH, 'utf8');
      const loadedConstants = JSON.parse(configContent);
      FIRST_EVER_PHRASE_START_EPOCH = loadedConstants.FIRST_EVER_PHRASE_START_EPOCH || FIRST_EVER_PHRASE_START_EPOCH;
      PHRASE_DURATION_EPOCHS = loadedConstants.PHRASE_DURATION_EPOCHS || PHRASE_DURATION_EPOCHS;
      AVG_BLOCK_TIME_SECONDS = loadedConstants.AVG_BLOCK_TIME_SECONDS || AVG_BLOCK_TIME_SECONDS;
      EPOCH_FAIL_THRESHOLD_SECONDS = loadedConstants.EPOCH_FAIL_THRESHOLD_SECONDS || EPOCH_FAIL_THRESHOLD_SECONDS;
      await logMessage(`Konstanta global dimuat dari ${GLOBAL_CONSTANTS_CONFIG_PATH}.`, 'SYSTEM');
    } catch (err) {
      if (err.code === 'ENOENT') {
        await logMessage(`File konfigurasi global tidak ditemukan: ${GLOBAL_CONSTANTS_CONFIG_PATH}. Membuat dengan konstanta default.`, 'WARN');
        await fs.writeFile(GLOBAL_CONSTANTS_CONFIG_PATH, JSON.stringify({
          FIRST_EVER_PHRASE_START_EPOCH,
          PHRASE_DURATION_EPOCHS,
          AVG_BLOCK_TIME_SECONDS,
          EPOCH_FAIL_THRESHOLD_SECONDS
        }, null, 2));
      } else {
        await logMessage(`Error memuat file konfigurasi global: ${err.message}. Menggunakan konstanta default.`, 'ERROR');
      }
    }

  } catch (err) {
    console.error(`FATAL: Gagal membuat direktori atau menginisialisasi log stream: ${err.message}`);
    process.exit(1);
  }

  const initialNetworkEpoch = await getCurrentNetworkEpochFromPolkadotApi();
  if (initialNetworkEpoch === -1) {
    await logMessage("Gagal mendapatkan epoch jaringan pada inisialisasi. Penjadwalan ulang inisialisasi.", 'ERROR');
    setTimeout(initializeAndStartMonitoring, EPOCH_CHECK_INTERVAL_MS);
    return;
  }
  lastKnownNetworkEpoch = initialNetworkEpoch;

  let initialPhraseNumber = calculatePhraseNumber(initialNetworkEpoch);
  if (initialPhraseNumber < 1) {
    currentPhraseNumber = 1;
    currentPhraseStartEpochForMonitoring = FIRST_EVER_PHRASE_START_EPOCH;
    phraseMonitoringData = {};
    currentPhraseMetadata = {
      phraseNumber: currentPhraseNumber,
      phraseStartEpoch: currentPhraseStartEpochForMonitoring,
      phraseEndEpoch: currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1,
      phraseStartTime: null
    };
    await savePhraseMetadata(currentPhraseMetadata);
    await logMessage(`Epoch jaringan (${initialNetworkEpoch}) lebih awal dari frasa pertama (${FIRST_EVER_PHRASE_START_EPOCH}). Menunggu frasa pertama (Frasa ${currentPhraseNumber}).`, 'PHRASE');
  } else {
    currentPhraseNumber = initialPhraseNumber;
    currentPhraseStartEpochForMonitoring = getStartEpochForPhrase(currentPhraseNumber);
    phraseMonitoringData = await loadPhraseMonitoringData(currentPhraseNumber); // Muat data yang sudah ada
    // Muat atau inisialisasi metadata frasa
    let loadedMetadata = await loadPhraseMetadata(currentPhraseNumber);
    if (Object.keys(loadedMetadata).length === 0) {
      currentPhraseMetadata = {
        phraseNumber: currentPhraseNumber,
        phraseStartEpoch: currentPhraseStartEpochForMonitoring,
        phraseEndEpoch: currentPhraseStartEpochForMonitoring + PHRASE_DURATION_EPOCHS - 1,
        phraseStartTime: null // Akan diisi jika awal frasa dimulai saat bot berjalan
      };
      await savePhraseMetadata(currentPhraseMetadata);
      await logMessage(`Metadata frasa ${currentPhraseNumber} diinisialisasi pada startup.`, 'PHRASE');
    } else {
      currentPhraseMetadata = loadedMetadata;
    }
  }

  // NEW: Inisialisasi data untuk validator yang ada di RPC saat startup
  const api = await initializeGlobalPolkadotApi();
  let initialRpcActiveValidators = [];
  if (api) {
    try {
      initialRpcActiveValidators = (await api.query.session.validators()).map(v => v.toString());
      await logMessage(`Ditemukan ${initialRpcActiveValidators.length} validator aktif di RPC saat startup.`, 'API_HELPER');
    } catch (e) {
      await logMessage(`Error mengambil validator aktif dari RPC saat startup: ${e.message}`, 'ERROR');
    }
  }
  const initialRpcActiveValidatorsSet = new Set(initialRpcActiveValidators);
  const currentTime = Date.now();

  for (const validatorAddress of initialRpcActiveValidatorsSet) {
    // Untuk validator yang ditemukan aktif saat startup:
    // Cukup inisialisasi data untuk epoch saat ini.
    // Epoch historis tidak akan diisi atau dievaluasi untuk mereka saat startup.
    initializeValidatorPhraseEpochData(validatorAddress, currentPhraseNumber, initialNetworkEpoch, currentTime);
    const epochData = phraseMonitoringData[validatorAddress][`phrase_${currentPhraseNumber}`]?.epochs?.[initialNetworkEpoch];

    if (epochData) {
      // Set initial state based on RPC activity
      epochData.lastApiHelperState = 'AKTIF_API';
      epochData.lastApiHelperStateChangeTimestamp = new Date(currentTime).toISOString();

      // Isi epochStartTime jika belum ada, menggunakan estimasi
      if (epochData.epochStartTime === null) {
        const estimatedTime = await getEpochStartTimestamp(initialNetworkEpoch);
        if (estimatedTime) {
          epochData.epochStartTime = estimatedTime;
          logMessage(`Epoch ${initialNetworkEpoch} (Frasa ${currentPhraseNumber}) untuk ${validatorAddress} dimulai pada ${estimatedTime} (estimasi startup).`, 'EPOCH');
        } else {
          logMessage(`Epoch ${initialNetworkEpoch} (Frasa ${currentPhraseNumber}) untuk ${validatorAddress}: Gagal mengestimasi waktu mulai epoch pada startup.`, 'WARN');
        }
      }
    }
  }
  // Simpan data awal yang diinisialisasi ini
  if (Object.keys(phraseMonitoringData).length > 0 && currentPhraseNumber !== -1) {
    await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
  }


  // Mulai loop utama
  epochCheckIntervalId = setTimeout(epochAndPhraseManagementLoopForApiHelper, 0);
  apiHelperCheckIntervalId = setInterval(checkApiHelperStatusForAllNodes, CHECK_INTERVAL_MS);

  app.listen(3000, '0.0.0.0', () => {
    logMessage(`Web server dashboard berjalan di http://0.0.0.0:3000`, "SYSTEM");
    logMessage(`Pastikan Anda membuat folder 'views' di direktori yang sama dengan skrip ini,`, "SYSTEM");
    logMessage(`dan di dalamnya terdapat file 'dashboard.ejs' dan 'validator_detail.ejs'.`, "SYSTEM");
  });

  await logMessage(`Pengecekan status API helper dijadwalkan setiap ${CHECK_INTERVAL_MS / 60000} menit.`, 'SYSTEM');
  await logMessage(`Manajemen Epoch & Frasa dijadwalkan setiap ${EPOCH_CHECK_INTERVAL_MS / 60000} menit.`, 'SYSTEM');
}

// --- Penanganan Proses Tetap Sama ---
process.on('SIGINT', async () => {
  await logMessage('SIGINT diterima. Menghentikan API Helper Monitor dan menyimpan data terakhir...', 'SYSTEM');
  if (apiHelperCheckIntervalId) clearInterval(apiHelperCheckIntervalId);
  if (epochCheckIntervalId) clearTimeout(epochCheckIntervalId);
  if (polkadotApi) await polkadotApi.disconnect().catch(e => logMessage(`Error saat disconnect API global pada SIGINT: ${e.message}`, 'ERROR'));

  const currentTimeForExit = Date.now();
  if (lastKnownNetworkEpoch !== -1 && currentPhraseNumber !== -1) {
    const api = await initializeGlobalPolkadotApi(); // Re-initialize API to get current active validators for final state save
    let currentRpcActiveValidators = [];
    if (api) {
      try { currentRpcActiveValidators = (await api.query.session.validators()).map(v => v.toString()); }
      catch (e) { await logMessage(`Error getting RPC validators on SIGINT: ${e.message}`, 'ERROR'); }
    }
    const currentRpcActiveValidatorsSet = new Set(currentRpcActiveValidators);

    // Iterate through all currently monitored validators for final state update
    for (const validatorAddress in phraseMonitoringData) {
      const phraseKey = `phrase_${currentPhraseNumber}`;
      const phraseData = phraseMonitoringData[validatorAddress]?.[phraseKey];
      if (phraseData && phraseData.epochs[lastKnownNetworkEpoch]) {
        const epochData = phraseData.epochs[lastKnownNetworkEpoch];
        // Only update if it's currently running (BERJALAN) and its state is considered inactive
        if (epochData.status === 'BERJALAN') { // Don't touch if already final (PASS/FAIL/NO_DATA)
          const isCurrentlyRpcActive = currentRpcActiveValidatorsSet.has(validatorAddress);
          // If previously active and now not active, or if it was inactive and remains inactive
          if (epochData.lastApiHelperState === 'AKTIF_API' && !isCurrentlyRpcActive ||
            epochData.lastApiHelperState === 'TIDAK_AKTIF_API' && !isCurrentlyRpcActive) {
            updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTimeForExit);
            epochData.lastApiHelperState = 'TIDAK_AKTIF_API'; // Ensure final state is inactive if it was
          } else if (epochData.lastApiHelperState === 'TIDAK_DIKETAHUI') { // Handle initial unknown state during shutdown
            epochData.lastApiHelperState = isCurrentlyRpcActive ? 'AKTIF_API' : 'TIDAK_AKTIF_API';
            if (epochData.lastApiHelperState === 'TIDAK_AKTIF_API') updateApiHelperInactiveDuration(validatorAddress, currentPhraseNumber, lastKnownNetworkEpoch, currentTimeForExit);
          }
          epochData.lastApiHelperStateChangeTimestamp = new Date(currentTimeForExit).toISOString(); // Update timestamp
        }
      }
    }
  }

  if (currentPhraseNumber !== -1 && Object.keys(phraseMonitoringData).length > 0) {
    await savePhraseMonitoringData(currentPhraseNumber, phraseMonitoringData);
  }
  // Simpan metadata frasa saat shutdown
  if (currentPhraseMetadata && Object.keys(currentPhraseMetadata).length > 0 && currentPhraseMetadata.phraseNumber === currentPhraseNumber) {
    await savePhraseMetadata(currentPhraseMetadata);
  }


  if (logStream) {
    logStream.end(() => {
      logMessage('API Helper Monitor dihentikan.', 'SYSTEM');
      process.exit(0);
    });
  } else {
    logMessage('API Helper Monitor dihentikan (stream tidak aktif).', 'SYSTEM');
    process.exit(0);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logMessage(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "ERROR");
  console.error(reason);
});

process.on('uncaughtException', (error) => {
  logMessage(`Uncaught Exception: ${error.message}`, "ERROR");
  console.error(error.stack);
  process.exit(1);
});

initializeAndStartMonitoring().catch(error => {
  logMessage(`Error kritis saat inisialisasi API Helper Monitor: ${error.message} ${error.stack || ''}`, 'ERROR');
  process.exit(1);
});
