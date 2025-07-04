const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000; // Port tempat server Anda akan berjalan

const allowlistPath = path.join(__dirname, 'config/allowlist.json');
let redirectData = {};

/**
 * Fungsi untuk membaca dan mem-parsing file allowlist.json.
 * Fungsi ini akan dipanggil saat server pertama kali dijalankan
 * dan setiap kali ada perubahan pada file.
 */
const loadAllowlist = () => {
  try {
    const jsonData = fs.readFileSync(allowlistPath, 'utf8');
    redirectData = JSON.parse(jsonData);
    console.log('Berhasil memuat/memuat ulang data dari allowlist.json.');
  } catch (error) {
    // Jika terjadi error saat reload (misal: file JSON tidak valid saat disimpan),
    // server akan tetap berjalan dengan data lama yang valid.
    console.error("Gagal membaca atau mem-parsing allowlist.json. Server akan tetap menggunakan data lama (jika ada).", error.message);
  }
};

// Memuat data untuk pertama kali saat server dijalankan.
// Jika gagal pada saat pertama kali, server akan berhenti.
try {
  if (fs.existsSync(allowlistPath)) {
    loadAllowlist();
  } else {
    throw new Error('File allowlist.json tidak ditemukan di direktori config.');
  }
} catch (error) {
  console.error("Error kritis saat startup:", error.message);
  process.exit(1); // Keluar jika file data tidak ada atau tidak valid saat startup.
}

// Memantau perubahan pada file allowlist.json
// fs.watch akan mendeteksi setiap kali file disimpan.
fs.watch(allowlistPath, (eventType, filename) => {
  if (filename) {
    console.log(`\nFile '${filename}' telah berubah (event: ${eventType}). Memuat ulang data...`);
    loadAllowlist();
  }
});

// Route utama untuk menangani pengalihan
app.get('/:name', (req, res) => {
  const requestedName = req.params.name.toLowerCase();

  // Cari data pengguna berdasarkan properti 'name' di dalam data yang sudah di-load
  const user = Object.values(redirectData).find(
    (userData) => userData && typeof userData.name === 'string' && userData.name.toLowerCase() === requestedName
  );

  if (user && user.ip && user.port) {
    // Jika pengguna ditemukan dan memiliki IP serta Port, lakukan redirect
    const redirectUrl = `http://${user.ip}:${user.port}`;
    console.log(`Mengalihkan '${requestedName}' ke ${redirectUrl}`);
    return res.redirect(302, redirectUrl); // 302 = Pengalihan sementara
  } else {
    // Jika tidak ditemukan atau data tidak lengkap, kirim 404 Not Found
    console.log(`Pengguna '${requestedName}' tidak ditemukan atau data tidak lengkap.`);
    return res.status(404).send('Not Found');
  }
});

// Jalankan server
app.listen(PORT, () => {
  console.log(`Server redirect berjalan di http://localhost:${PORT}`);
  console.log(`Memantau perubahan pada: ${allowlistPath}`);
});
