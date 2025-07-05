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
const ROOT_DIR = '~/Downloads/coding/notif'; // Sesuaikan dengan path ROOT_DIR Anda
const PHRASE_DATA_DIR = path.join('api_helper_phrase_data');
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
                this.api = null; // Reset API object on disconnect
                this.connectionAttempts = 0; // Reset attempts for next connection
            });
            this.api.on('error', (error) => {
                console.error('EpochChecker: Error pada koneksi Polkadot API:', error.message);
                this.api = null; // Reset API object on error
            });

            console.log('EpochChecker: Berhasil terhubung ke Humanode network.');
            this.connectionAttempts = 0; // Reset attempts on successful connection
            return this;
        } catch (error) {
            this.connectionAttempts++;
            console.error(`EpochChecker: Gagal terhubung (Percobaan ${this.connectionAttempts}):`, error.message);
            this.api = null;
            if (this.connectionAttempts >= this.maxConnectionAttempts) {
                console.error(`EpochChecker: Gagal terhubung setelah ${this.maxConnectionAttempts} percobaan.`);
                // Consider not throwing here if you want the app to continue with cached/default data
            }
            throw error; // Re-throw error to be caught by caller if necessary
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
                    // Gagal menghubungkan, kembalikan data default dengan pesan error
                    return this.getDefaultEpochData(null, `Gagal menghubungkan ke node: ${connectError.message}`);
                }
            } else {
                // Sudah mencapai maksimal percobaan, kembalikan data default
                return this.getDefaultEpochData(null, `Koneksi ke node tidak tersedia setelah ${this.maxConnectionAttempts} percobaan.`);
            }
        }
        // Jika setelah percobaan connect API masih null (misalnya karena error saat connect),
        // kembalikan data default.
        if (!this.api) {
            return this.getDefaultEpochData(null, `API tidak terinisialisasi setelah percobaan koneksi.`);
        }

        try {
            // Mengambil data sesi, indeks epoch, dan header blok terbaru secara paralel
            const [sessionInfo, epochIdxData, currentBlockHeader] = await Promise.all([
                firstValueFrom(this.api.derive.session.progress()),
                // Pastikan 'babe' pallet dan 'epochIndex' storage item ada
                this.api.query.babe ? firstValueFrom(this.api.query.babe.epochIndex()) : Promise.resolve(null),
                firstValueFrom(this.api.rpc.chain.getHeader())
            ]);

            const totalBlocksInEpoch = sessionInfo.sessionLength.toNumber();
            const currentBlockInSession = sessionInfo.sessionProgress.toNumber();
            const remainingBlocksInEpoch = totalBlocksInEpoch > 0 ? totalBlocksInEpoch - currentBlockInSession : 0;
            const percentageCompleted = totalBlocksInEpoch > 0 ? (currentBlockInSession / totalBlocksInEpoch) * 100 : 0;

            // epochIdxData bisa null jika query babe.epochIndex() tidak ada atau gagal
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
                error: null // Tidak ada error
            };
        } catch (error) {
            console.error('⚠️ EpochChecker: Error mengambil data epoch:', error.message);
            let currentEpochFallback = null;
            // Coba dapatkan epoch index sebagai fallback jika error utama terjadi
            try {
                if (this.api && this.api.query.babe) { // Pastikan api masih ada
                    const fallbackEpochIdx = await firstValueFrom(this.api.query.babe.epochIndex());
                    currentEpochFallback = fallbackEpochIdx ? fallbackEpochIdx.toNumber() : null;
                }
            } catch (e) {
                console.warn('EpochChecker: Gagal mendapatkan fallback epoch index:', e.message);
            }
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
        if (typeof blocks !== 'number' || blocks < 0) return 'N/A';
        const totalSeconds = blocks * BLOCK_TIME_SECONDS_ASSUMPTION;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        return `${hours} jam ${minutes} menit`;
    }

    estimateCompletionTime(blocks) {
        if (typeof blocks !== 'number' || blocks < 0) return 'N/A';
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
app.set('views', path.join(__dirname, 'views')); // Pastikan ada folder 'views'

// --- Fungsi Utilitas untuk Data Frasa ---
async function getLatestAvailablePhraseNumber() {
    try {
        const files = await fs.readdir(PHRASE_DATA_DIR);
        const phraseNumbers = files
            .map(file => {
                const match = file.match(/api_helper_phrase_(\d+)_data\.json/);
                return match ? parseInt(match[1], 10) : null;
            })
            .filter(num => num !== null && !isNaN(num)); // Pastikan num adalah angka valid
        if (phraseNumbers.length === 0) return 0;
        return Math.max(...phraseNumbers);
    } catch (error) {
        console.error(`Error membaca direktori data frasa (${PHRASE_DATA_DIR}): ${error.message}`);
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
        await fs.access(filePath); // Cek apakah file ada dan dapat diakses
        const data = await fs.readFile(filePath, 'utf8');
        console.log(`Memuat data untuk frasa ${phraseNumber} dari ${filePath}`);
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`File data untuk frasa ${phraseNumber} tidak ditemukan di ${filePath}.`);
        } else {
            console.error(`Gagal memuat atau parse JSON untuk frasa ${phraseNumber} (${filePath}): ${error.message}`);
        }
        return null;
    }
}

// BARU: Fungsi untuk mengkategorikan status epoch untuk ringkasan
function categorizeEpochStatus(statusString) {
    if (!statusString) return 'UNKNOWN'; // Atau 'OTHER' jika lebih sesuai
    const upperStatus = statusString.toUpperCase();
    if (['PASS_API_HELPER', 'PARTICIPATED', 'PASS'].includes(upperStatus)) {
        return 'PASS';
    } else if (['FAIL_API_HELPER', 'MISSED', 'FAIL'].includes(upperStatus)) {
        return 'FAIL';
    } else if (['SKIP_HISTORIS', 'SKIP'].includes(upperStatus)) {
        return 'SKIP';
    }
    // Status seperti BERJALAN, PENDING, RUNNING akan dianggap 'OTHER' untuk frasa lama
    // karena seharusnya frasa lama sudah selesai.
    return 'OTHER';
}

// --- Routes ---
app.get('/validator/:address', async (req, res) => {
    const validatorAddress = req.params.address;
    let latestPhraseNumber = 0; // Akan diisi dengan nomor frasa terbaru yang valid datanya
    let displayPhraseStartEpoch = null;
    let displayPhraseEndEpoch = null;
    let phraseDataForValidatorLatest = null; // Data untuk frasa terbaru validator spesifik
    let errorMessage = null;
    let allEpochsInLatestPhrase = [];
    let actualPhraseStartTime = null;
    let estimatedPhraseEndTime = null;
    let liveEpochProgressData = epochChecker.getDefaultEpochData(); // Inisialisasi dengan default

    const phraseHistory = []; // BARU: Array untuk menyimpan riwayat frasa

    try {
        // 1. Ambil data progres epoch secara LIVE
        liveEpochProgressData = await epochChecker.getEpochProgress();

        // 2. Logika untuk data frasa
        const maxKnownPhraseNumber = await getLatestAvailablePhraseNumber(); // Nomor frasa tertinggi yang filenya ada

        if (maxKnownPhraseNumber < 1) {
            errorMessage = `Tidak ada file data frasa yang ditemukan di direktori ${PHRASE_DATA_DIR}. Pastikan path sudah benar dan file ada.`;
            // Set display epoch ke fallback jika tidak ada data frasa
            displayPhraseStartEpoch = calculateTheoreticalStartEpochForPhrase(1); // Asumsi frasa 1 jika tidak ada file
            displayPhraseEndEpoch = displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1;
        } else {
            // Loop melalui semua nomor frasa yang mungkin ada, dari 1 hingga maxKnownPhraseNumber
            // untuk membangun riwayat dan menemukan data frasa terbaru.
            for (let currentPhraseNum = 1; currentPhraseNum <= maxKnownPhraseNumber; currentPhraseNum++) {
                const phraseFileContent = await loadPhraseMonitoringDataFile(currentPhraseNum);

                if (phraseFileContent) {
                    const validatorDataForCurrentPhrase = phraseFileContent[validatorAddress];
                    const phraseKey = `phrase_${currentPhraseNum}`;
                    let phraseDetailsToUse = null; // Detail frasa untuk validator ini atau umum

                    // Coba dapatkan data untuk validator spesifik
                    if (validatorDataForCurrentPhrase && validatorDataForCurrentPhrase[phraseKey]) {
                        phraseDetailsToUse = validatorDataForCurrentPhrase[phraseKey];
                    } else {
                        // Jika validator spesifik tidak ada, coba ambil dari validator pertama sebagai fallback untuk info umum frasa
                        // Ini berguna untuk mendapatkan phraseStartEpoch dan phraseEndEpoch umum jika validator tidak ada di file itu
                        const firstValidatorKey = Object.keys(phraseFileContent).find(
                            key => key !== 'phraseMetadata' && phraseFileContent[key] && phraseFileContent[key][phraseKey]
                        );
                        if (firstValidatorKey) {
                            phraseDetailsToUse = phraseFileContent[firstValidatorKey][phraseKey];
                            // Jika ini frasa terbaru dan validator spesifik tidak ada, catat pesan
                            if (currentPhraseNum === maxKnownPhraseNumber && !errorMessage) {
                                errorMessage = `Validator ${validatorAddress} tidak ditemukan dalam data frasa ${currentPhraseNum}. Menampilkan info umum frasa terbaru dan riwayat.`;
                            }
                        }
                    }

                    if (phraseDetailsToUse) {
                        const epochsData = phraseDetailsToUse.epochs || {};
                        let passCount = 0;
                        let skipCount = 0;
                        let failCount = 0;
                        let otherCount = 0;

                        // Hitung status untuk riwayat, hanya untuk validator spesifik jika ada
                        // Jika tidak, riwayat untuk validator ini akan kosong untuk frasa ini.
                        if (validatorDataForCurrentPhrase && validatorDataForCurrentPhrase[phraseKey] && validatorDataForCurrentPhrase[phraseKey].epochs) {
                            const validatorEpochs = validatorDataForCurrentPhrase[phraseKey].epochs;
                            for (const epochNumStr in validatorEpochs) {
                                const epochDetail = validatorEpochs[epochNumStr];
                                const categorizedStatus = categorizeEpochStatus(epochDetail.status);
                                if (categorizedStatus === 'PASS') passCount++;
                                else if (categorizedStatus === 'SKIP') skipCount++;
                                else if (categorizedStatus === 'FAIL') failCount++;
                                else otherCount++;
                            }
                        }

                        const pStartEpoch = phraseDetailsToUse.phraseStartEpoch || calculateTheoreticalStartEpochForPhrase(currentPhraseNum);
                        const pEndEpoch = phraseDetailsToUse.phraseEndEpoch || (pStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1);

                        // Tambahkan ke riwayat jika ada data epoch untuk validator atau jika ini adalah data umum frasa
                        // Namun, hitungan (pass/skip/fail) hanya relevan jika data validator spesifik ada.
                        phraseHistory.push({
                            phraseNumber: currentPhraseNum,
                            startEpoch: pStartEpoch,
                            endEpoch: pEndEpoch,
                            passCount, // Akan 0 jika validatorDataForCurrentPhrase tidak ada
                            skipCount, // Akan 0 jika validatorDataForCurrentPhrase tidak ada
                            failCount, // Akan 0 jika validatorDataForCurrentPhrase tidak ada
                            otherCount, // Akan 0 jika validatorDataForCurrentPhrase tidak ada
                            hasSpecificData: !!(validatorDataForCurrentPhrase && validatorDataForCurrentPhrase[phraseKey])
                        });

                        // Jika ini adalah frasa terbaru (berdasarkan loop), siapkan data untuk tampilan detail
                        if (currentPhraseNum === maxKnownPhraseNumber) {
                            latestPhraseNumber = currentPhraseNum; // Set nomor frasa terbaru yang valid
                            // Hanya set phraseDataForValidatorLatest jika data validator spesifik ADA
                            if (validatorDataForCurrentPhrase && validatorDataForCurrentPhrase[phraseKey]) {
                                phraseDataForValidatorLatest = phraseDetailsToUse;
                            }
                            displayPhraseStartEpoch = pStartEpoch;
                            displayPhraseEndEpoch = pEndEpoch;
                            actualPhraseStartTime = phraseDetailsToUse.phraseStartTime;

                            if (displayPhraseStartEpoch > 0) {
                                allEpochsInLatestPhrase = [];
                                const durationToUse = (displayPhraseEndEpoch - displayPhraseStartEpoch) + 1;
                                for (let i = 0; i < durationToUse; i++) {
                                    allEpochsInLatestPhrase.push(displayPhraseStartEpoch + i);
                                }
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
                                    } else { console.warn(`Format actualPhraseStartTime tidak valid: ${actualPhraseStartTime}`); }
                                } catch (e) { console.warn(`Error menghitung estimatedPhraseEndTime: ${e.message}`); }
                            }
                        }
                    } else if (currentPhraseNum === maxKnownPhraseNumber && !errorMessage) {
                        // File frasa terbaru ada, tapi tidak ada data phraseKey yang valid di dalamnya (misal, struktur JSON salah)
                        latestPhraseNumber = currentPhraseNum; // Tetap set sebagai frasa terbaru yang dicoba
                        errorMessage = errorMessage || `Tidak ada data detail (seperti phraseStartEpoch) yang ditemukan dalam file frasa ${currentPhraseNum}. File mungkin kosong atau formatnya salah.`;
                        displayPhraseStartEpoch = calculateTheoreticalStartEpochForPhrase(currentPhraseNum);
                        displayPhraseEndEpoch = displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1;
                    }
                } else if (currentPhraseNum === maxKnownPhraseNumber) {
                    // File untuk frasa terbaru tidak ditemukan
                    latestPhraseNumber = currentPhraseNum; // Tetap set sebagai frasa terbaru yang dicoba
                    errorMessage = errorMessage || `File data frasa ${currentPhraseNum} (terbaru) tidak ditemukan.`;
                    displayPhraseStartEpoch = calculateTheoreticalStartEpochForPhrase(currentPhraseNum);
                    displayPhraseEndEpoch = displayPhraseStartEpoch + PHRASE_DURATION_EPOCHS_FALLBACK - 1;
                }
            } // Akhir loop for (currentPhraseNum)
        }
    } catch (error) {
        console.error("Error di route /validator/:address :", error);
        errorMessage = errorMessage || `Terjadi kesalahan server saat memproses data: ${error.message}`;
        // Pastikan liveEpochProgressData memiliki struktur default jika error terjadi di luar blok try-nya
        if (!liveEpochProgressData || Object.keys(liveEpochProgressData).length === 0) {
            liveEpochProgressData = epochChecker.getDefaultEpochData(null, "Kesalahan server internal.");
        }
    }

    // Urutkan riwayat frasa, dari terbaru ke terlama untuk tampilan
    phraseHistory.sort((a, b) => b.phraseNumber - a.phraseNumber);

    res.render('validator_status', {
        validatorAddress,
        currentNetworkEpoch: liveEpochProgressData ? liveEpochProgressData.currentEpochSystem : null,
        webServerEpochProgress: liveEpochProgressData,

        latestPhraseNumber: latestPhraseNumber >= 1 ? latestPhraseNumber : null,
        latestPhraseStartEpoch: displayPhraseStartEpoch,
        latestPhraseEndEpoch: displayPhraseEndEpoch,
        phraseData: phraseDataForValidatorLatest, // Data HANYA untuk frasa terbaru validator spesifik
        actualPhraseStartTimeForDisplay: actualPhraseStartTime,
        allEpochsInLatestPhrase: allEpochsInLatestPhrase.length > 0 ? allEpochsInLatestPhrase : [],
        estimatedPhraseEndTime: estimatedPhraseEndTime,

        errorMessage, // Pesan error utama untuk halaman
        FIRST_EVER_PHRASE_START_EPOCH: FIRST_EVER_PHRASE_START_EPOCH_FALLBACK,
        PHRASE_DURATION_EPOCHS: PHRASE_DURATION_EPOCHS_FALLBACK,
        pageTitle: `Status Validator ${validatorAddress}`, // Tambahan untuk judul halaman

        phraseHistory: phraseHistory // BARU: Teruskan data riwayat ke EJS
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
                body { font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; margin: 0; background-color: #f4f4f4; color: #333; }
                .container { max-width: 800px; margin: 20px auto; padding: 20px; background-color: #fff; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
                h1 { color: #333; text-align: center; }
                p { margin-bottom: 1em; }
                code { background-color: #e9e9e9; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
                a { color: #007bff; text-decoration: none; }
                a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Selamat Datang di Monitor Validator Humanode</h1>
                <p>Ini adalah server backend untuk menampilkan status partisipasi validator dalam frasa Humanode.</p>
                <p>Untuk melihat status validator tertentu, navigasikan ke URL dengan format:</p>
                <p><code>/validator/&lt;ALAMAT_VALIDATOR_ANDA&gt;</code></p>
                <p>Contoh: <code><a href="/validator/hmpsvuEucaxX69U6kndznmJ1teXwqe3hAcyfUmPFaHgd7rmCt">/validator/hmpsvuEucaxX69U6kndznmJ1teXwqe3hAcyfUmPFaHgd7rmCt</a></code></p>
                <p>Pastikan server ini memiliki akses baca ke direktori <code>${PHRASE_DATA_DIR}</code> yang berisi file-file JSON data frasa (misalnya, <code>api_helper_phrase_1_data.json</code>, <code>api_helper_phrase_2_data.json</code>, dst.).</p>
            </div>
        </body>
        </html>
    `);
});

// --- Jalankan Server ---
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server berjalan di http://0.0.0.0:${PORT}`);
    console.log(`Server membaca data frasa dari: '${PHRASE_DATA_DIR}'`);
    console.log(`Mohon pastikan direktori '${PHRASE_DATA_DIR}' dapat diakses dan berisi file data frasa.`);
    console.log(`Pastikan juga ada folder 'views' dengan file 'validator_status.ejs' di direktori yang sama dengan web_server.js.`);
    try {
        await epochChecker.connect(); // Coba hubungkan EpochChecker saat server mulai
    } catch (e) {
        // Pesan ini sudah dicetak oleh EpochChecker, jadi bisa dikurangi di sini jika mau
        console.warn("Peringatan: EpochChecker gagal terhubung saat startup. Akan mencoba lagi pada request berikutnya jika diperlukan.");
    }
});

// Graceful shutdown
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