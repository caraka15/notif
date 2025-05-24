// web_server.js
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { ApiRx, WsProvider } = require('@polkadot/api');
const { firstValueFrom } = require('rxjs');

// --- Konfigurasi Aplikasi ---
const app = express();
const PORT = 4000; // Port untuk web server
const HUMANODE_NODE_ENDPOINT = 'wss://explorer-rpc-ws.mainnet.stages.humanode.io'; // Endpoint Node Humanode
const BLOCK_TIME_SECONDS_ASSUMPTION = 6; // Asumsi waktu per blok (VERIFIKASI UNTUK HUMANODE)

// --- Konfigurasi Path & Data Frasa ---
const ROOT_DIR = '/root/notif'; // Sesuaikan dengan path ROOT_DIR Anda
const PHRASE_DATA_DIR = path.join(ROOT_DIR, 'api_helper_phrase_data');
const FIRST_EVER_PHRASE_START_EPOCH_FALLBACK = 5450;
const PHRASE_DURATION_EPOCHS_FALLBACK = 84;
const EPOCH_DURATION_HOURS = 4; // Durasi standar satu epoch dalam jam
const EPOCH_DURATION_SECONDS = EPOCH_DURATION_HOURS * 60 * 60;

// --- Class EpochChecker ---
class EpochChecker {
  constructor(endpoint = HUMANODE_NODE_ENDPOINT) {
    this.endpoint = endpoint;
    this.api = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
  }

  async connect() {
    if (this.api && this.api.isConnected) {
      return this;
    }
    try {
      console.log(`EpochChecker: Mencoba menghubungkan ke ${this.endpoint}... (Percobaan ${this.connectionAttempts + 1})`);
      this.api = await ApiRx.create({
        provider: new WsProvider(this.endpoint, 5000) // Timeout koneksi 5 detik
      }).toPromise();

      this.api.on('disconnected', () => {
        console.warn('EpochChecker: Koneksi Polkadot API terputus. Akan mencoba menghubungkan kembali pada request berikutnya.');
        this.api = null;
        this.connectionAttempts = 0;
      });
      this.api.on('error', (error) => {
        console.error('EpochChecker: Error pada koneksi Polkadot API:', error.message);
        this.api = null;
      });

      console.log('EpochChecker: Berhasil terhubung ke Humanode network.');
      this.connectionAttempts = 0;
      return this;
    } catch (error) {
      this.connectionAttempts++;
      console.error(`EpochChecker: Gagal terhubung (Percobaan ${this.connectionAttempts}):`, error.message);
      this.api = null;
      if (this.connectionAttempts >= this.maxConnectionAttempts) {
        console.error(`EpochChecker: Gagal terhubung setelah ${this.maxConnectionAttempts} percobaan.`);
      }
      throw error;
    }
  }

  async disconnect() {
    if (this.api) {
      console.log('EpochChecker: Memutuskan koneksi Polkadot API...');
      await this.api.disconnect();
      this.api = null;
      console.log('EpochChecker: Koneksi Polkadot API terputus.');
    }
  }

  async getEpochProgress() {
    if (!this.api || !this.api.isConnected) {
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        try {
          await this.connect();
        } catch (connectError) {
          return this.getDefaultEpochData(null, `Gagal menghubungkan ke node: ${connectError.message}`);
        }
      } else {
        return this.getDefaultEpochData(null, `Koneksi ke node tidak tersedia setelah ${this.maxConnectionAttempts} percobaan.`);
      }
    }
    if (!this.api) {
      return this.getDefaultEpochData(null, `API tidak terinisialisasi.`);
    }

    try {
      const [sessionInfo, epochIdxData, currentBlockHeader] = await Promise.all([
        firstValueFrom(this.api.derive.session.progress()),
        // VERIFIKASI PATH QUERY INI UNTUK HUMANODE:
        // Umumnya 'babe.epochIndex' atau 'staking.currentEra' (jika epoch = era)
        // Jika Humanode memiliki pallet/storage item berbeda, sesuaikan.
        this.api.query.babe ? firstValueFrom(this.api.query.babe.epochIndex()) : Promise.resolve(null),
        firstValueFrom(this.api.rpc.chain.getHeader())
      ]);

      const totalBlocksInEpoch = sessionInfo.sessionLength.toNumber();
      const currentBlockInSession = sessionInfo.sessionProgress.toNumber();
      const remainingBlocksInEpoch = totalBlocksInEpoch > 0 ? totalBlocksInEpoch - currentBlockInSession : 0;
      const percentageCompleted = totalBlocksInEpoch > 0 ? (currentBlockInSession / totalBlocksInEpoch) * 100 : 0;

      const currentAbsoluteEpochIndex = epochIdxData ? epochIdxData.toNumber() : null;
      const currentAbsoluteBlockNumber = currentBlockHeader.number.toNumber();

      return {
        currentEpochSystem: currentAbsoluteEpochIndex,
        blocksInEpoch: totalBlocksInEpoch,
        currentBlockInEpoch: currentBlockInSession,
        currentAbsoluteBlock: currentAbsoluteBlockNumber,
        remainingBlocksInEpoch: remainingBlocksInEpoch,
        percentageCompleted: parseFloat(percentageCompleted.toFixed(2)),
        nextEpochETA: this.formatBlocksToTime(remainingBlocksInEpoch),
        currentEpochEstimatedCompletion: this.estimateCompletionTime(remainingBlocksInEpoch),
        error: null
      };
    } catch (error) {
      console.error('⚠️ EpochChecker: Error mengambil data epoch:', error.message);
      let currentEpochFallback = null;
      try {
        if (this.api && this.api.query.babe) {
          const fallbackEpochIdx = await firstValueFrom(this.api.query.babe.epochIndex());
          currentEpochFallback = fallbackEpochIdx ? fallbackEpochIdx.toNumber() : null;
        }
      } catch (e) { /* abaikan error sekunder */ }
      return this.getDefaultEpochData(currentEpochFallback, `Gagal mengambil detail epoch: ${error.message}`);
    }
  }

  getDefaultEpochData(currentEpochSystem = null, errorMessage = 'Data tidak tersedia') {
    return {
      currentEpochSystem: currentEpochSystem,
      blocksInEpoch: 0,
      currentBlockInEpoch: 0,
      currentAbsoluteBlock: 0,
      remainingBlocksInEpoch: 0,
      percentageCompleted: 0,
      nextEpochETA: 'N/A',
      currentEpochEstimatedCompletion: 'N/A',
      error: errorMessage
    };
  }

  formatBlocksToTime(blocks) {
    const totalSeconds = blocks * BLOCK_TIME_SECONDS_ASSUMPTION;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours} jam ${minutes} menit`;
  }

  estimateCompletionTime(blocks) {
    const totalSeconds = blocks * BLOCK_TIME_SECONDS_ASSUMPTION;
    const completionDate = new Date(Date.now() + totalSeconds * 1000);
    return completionDate.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  }
}
// --- Akhir Class EpochChecker ---

// Inisialisasi EpochChecker
const epochChecker = new EpochChecker();

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // Pastikan ada folder 'views' di direktori yang sama

// --- Fungsi Utilitas untuk Data Frasa (dari kode Anda) ---
async function getLatestAvailablePhraseNumber() {
  try {
    const files = await fs.readdir(PHRASE_DATA_DIR);
    const phraseNumbers = files
      .map(file => {
        const match = file.match(/api_helper_phrase_(\d+)_data\.json/);
        return match ? parseInt(match[1]) : null;
      })
      .filter(num => num !== null);
    if (phraseNumbers.length === 0) return 0;
    return Math.max(...phraseNumbers);
  } catch (error) {
    console.error(`Error membaca direktori data frasa: ${error.message}`);
    return 0; // Kembalikan 0 jika error agar alur tidak rusak parah
  }
}

function calculateTheoreticalStartEpochForPhrase(phraseNumber) {
  if (phraseNumber < 1) return FIRST_EVER_PHRASE_START_EPOCH_FALLBACK; // Default jika tidak valid
  return FIRST_EVER_PHRASE_START_EPOCH_FALLBACK + (phraseNumber - 1) * PHRASE_DURATION_EPOCHS_FALLBACK;
}

async function loadPhraseMonitoringDataFile(phraseNumber) {
  if (typeof phraseNumber !== 'number' || phraseNumber < 1) {
    console.warn(`Gagal memuat data: nomor frasa tidak valid (${phraseNumber}).`);
    return null;
  }
  const filePath = path.join(PHRASE_DATA_DIR, `api_helper_phrase_${phraseNumber}_data.json`);
  try {
    await fs.access(filePath); // Cek apakah file ada
    const data = await fs.readFile(filePath, 'utf8');
    console.log(`Memuat data untuk frasa ${phraseNumber} dari ${filePath}`);
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`File data untuk frasa ${phraseNumber} tidak ditemukan di ${filePath}.`);
    } else {
      console.error(`Gagal memuat data untuk frasa ${phraseNumber}: ${error.message}`);
    }
    return null;
  }
}

// --- Routes ---
app.get('/validator/:address', async (req, res) => {
  const validatorAddress = req.params.address;
  let latestPhraseNumber = 0;
  let displayPhraseStartEpoch = null;
  let displayPhraseEndEpoch = null;
  let phraseDataForValidator = null;
  let errorMessage = null;
  let allEpochsInLatestPhrase = [];
  let actualPhraseStartTime = null;
  let estimatedPhraseEndTime = null;
  let liveEpochProgressData = epochChecker.getDefaultEpochData(); // Inisialisasi dengan default

  try {
    // 1. Ambil data progres epoch secara LIVE
    liveEpochProgressData = await epochChecker.getEpochProgress();

    // 2. Logika untuk data frasa (dari kode Anda)
    latestPhraseNumber = await getLatestAvailablePhraseNumber();

    if (latestPhraseNumber < 1) {
      errorMessage = `Tidak ada file data frasa yang ditemukan di ${PHRASE_DATA_DIR}.`;
      // Set display epoch ke fallback jika tidak ada data frasa
      displayPhraseStartEpoch = calculateTheoreticalStartEpochForPhrase(1); // Asumsi frasa 1 jika tidak ada file
      displayPhraseEndEpoch = displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1;
    } else {
      const allDataForLatestPhraseFile = await loadPhraseMonitoringDataFile(latestPhraseNumber);

      if (allDataForLatestPhraseFile) {
        if (allDataForLatestPhraseFile[validatorAddress] && allDataForLatestPhraseFile[validatorAddress][`phrase_${latestPhraseNumber}`]) {
          phraseDataForValidator = allDataForLatestPhraseFile[validatorAddress][`phrase_${latestPhraseNumber}`];
          displayPhraseStartEpoch = phraseDataForValidator.phraseStartEpoch;
          displayPhraseEndEpoch = phraseDataForValidator.phraseEndEpoch || (displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1);
          actualPhraseStartTime = phraseDataForValidator.phraseStartTime;
        } else {
          errorMessage = `Validator ${validatorAddress} tidak ditemukan dalam data frasa ${latestPhraseNumber}.`;
          const firstValidatorKey = Object.keys(allDataForLatestPhraseFile).find(key => key !== 'phraseMetadata');
          if (firstValidatorKey && allDataForLatestPhraseFile[firstValidatorKey][`phrase_${latestPhraseNumber}`]) {
            const generalPhraseData = allDataForLatestPhraseFile[firstValidatorKey][`phrase_${latestPhraseNumber}`];
            displayPhraseStartEpoch = generalPhraseData.phraseStartEpoch;
            displayPhraseEndEpoch = generalPhraseData.phraseEndEpoch || (displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1);
            actualPhraseStartTime = generalPhraseData.phraseStartTime;
          } else {
            displayPhraseStartEpoch = calculateTheoreticalStartEpochForPhrase(latestPhraseNumber);
            displayPhraseEndEpoch = displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1;
          }
        }

        if (displayPhraseStartEpoch !== null && displayPhraseStartEpoch > 0) {
          allEpochsInLatestPhrase = [];
          const durationToUse = (displayPhraseEndEpoch && displayPhraseStartEpoch) ? (displayPhraseEndEpoch - displayPhraseStartEpoch) + 1 : PHRASE_DURATION_EPOCHS_FALLBACK;
          for (let i = 0; i < durationToUse; i++) {
            allEpochsInLatestPhrase.push(displayPhraseStartEpoch + i);
          }
        } else if (!errorMessage && !(latestPhraseNumber < 1)) {
          errorMessage = errorMessage || `Tidak dapat menentukan rentang epoch untuk frasa ${latestPhraseNumber}.`;
        }

        if (actualPhraseStartTime) {
          try {
            const startTime = new Date(actualPhraseStartTime).getTime();
            if (!isNaN(startTime)) {
              const durationForCalc = (displayPhraseEndEpoch && displayPhraseStartEpoch) ?
                ((displayPhraseEndEpoch - displayPhraseStartEpoch) + 1) :
                PHRASE_DURATION_EPOCHS_FALLBACK;
              const endTimeMs = startTime + (durationForCalc * EPOCH_DURATION_SECONDS * 1000);
              estimatedPhraseEndTime = new Date(endTimeMs).toISOString();
            } else {
              console.warn(`Format actualPhraseStartTime tidak valid: ${actualPhraseStartTime}`);
            }
          } catch (e) {
            console.warn(`Error menghitung estimatedPhraseEndTime: ${e.message}`);
          }
        }
      } else {
        errorMessage = errorMessage || `File data frasa ${latestPhraseNumber} tidak ditemukan.`;
        displayPhraseStartEpoch = calculateTheoreticalStartEpochForPhrase(latestPhraseNumber);
        displayPhraseEndEpoch = displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1;
      }
    }
  } catch (error) {
    console.error("Error di route /validator/:address :", error);
    errorMessage = errorMessage || `Terjadi kesalahan server: ${error.message}`;
    // Pastikan liveEpochProgressData memiliki struktur default jika error terjadi di luar blok try-nya
    if (!liveEpochProgressData || Object.keys(liveEpochProgressData).length === 0) {
      liveEpochProgressData = epochChecker.getDefaultEpochData(null, "Kesalahan server internal.");
    }
  }

  res.render('validator_status', {
    validatorAddress,
    currentNetworkEpoch: liveEpochProgressData ? liveEpochProgressData.currentEpochSystem : null,
    webServerEpochProgress: liveEpochProgressData,
    latestPhraseNumber: latestPhraseNumber >= 1 ? latestPhraseNumber : null,
    latestPhraseStartEpoch: displayPhraseStartEpoch,
    latestPhraseEndEpoch: displayPhraseEndEpoch,
    phraseData: phraseDataForValidator,
    actualPhraseStartTimeForDisplay: actualPhraseStartTime,
    allEpochsInLatestPhrase: allEpochsInLatestPhrase.length > 0 ? allEpochsInLatestPhrase : [],
    estimatedPhraseEndTime: estimatedPhraseEndTime,
    errorMessage,
    FIRST_EVER_PHRASE_START_EPOCH: FIRST_EVER_PHRASE_START_EPOCH_FALLBACK,
    PHRASE_DURATION_EPOCHS: PHRASE_DURATION_EPOCHS_FALLBACK,
    pageTitle: `Status Validator ${validatorAddress}` // Tambahan untuk judul halaman
  });
});

app.get('/', (req, res) => {
  res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Monitor Validator Humanode</title>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; }
                code { background-color: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <h1>Selamat Datang di Monitor Validator Humanode</h1>
            <p>Ini adalah server backend untuk menampilkan status validator.</p>
            <p>Untuk melihat status validator tertentu, navigasikan ke URL dengan format:</p>
            <p><code>/validator/&lt;ALAMAT_VALIDATOR_ANDA&gt;</code></p>
            <p>Contoh: <code><a href="/validator/hmpsvuEucaxX69U6kndznmJ1teXwqe3hAcyfUmPFaHgd7rmCt">/validator/hmpsvuEucaxX69U6kndznmJ1teXwqe3hAcyfUmPFaHgd7rmCt</a></code></p>
        </body>
        </html>
    `);
});

// --- Jalankan Server ---
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server berjalan di http://0.0.0.0:${PORT}`);
  console.log(`Server membaca data frasa dari: '${PHRASE_DATA_DIR}'`);
  console.log(`Mohon pastikan direktori '${PHRASE_DATA_DIR}' dapat diakses.`);
  console.log(`Pastikan juga ada folder 'views' dengan file 'validator_status.ejs' di direktori yang sama dengan web_server.js.`);
  try {
    await epochChecker.connect(); // Hubungkan EpochChecker saat server mulai
  } catch (e) {
    console.warn("Peringatan: EpochChecker gagal terhubung saat startup. Akan mencoba lagi pada request berikutnya.");
  }
});

process.on('SIGINT', async () => {
  console.log('SIGINT diterima. Server dimatikan.');
  await epochChecker.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM diterima. Server dimatikan.');
  await epochChecker.disconnect();
  process.exit(0);
});