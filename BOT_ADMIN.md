## SETUP ADMIN (WHATSAPP DAN TELEGRAM BOT)

pilih salah satu mau WHATSAPP BOT ATAU TELEGRAM BOT yang dijalankan

### 1. Install dependencies tambahan
  ```
  apt-get update && apt-get install -y \
      # Basic Chrome dependencies
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      # SSL and basic utilities
      ca-certificates \
      fonts-liberation \
      libappindicator1 \
      libnss3 \
      lsb-release \
      xdg-utils \
      wget \
      # Sound and media dependencies
      libasound2 \
      # GTK and visual dependencies
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libgdk-pixbuf2.0-0 \
      libgtk-3-0 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      # Additional dependencies for stability
      libgbm-dev \
      libglib2.0-0 \
      libnss3-dev \
      libxcb-dri3-0 \
      libdrm2 \
      libgbm1
  ```
### 2. Server Admin (WhatsApp Bot)

- Menjalankan bot WhatsApp untuk monitoring
- Terdiri dari:
  - wa.js - Bot untuk registrasi
  - monitor.js - Service monitoring
- Fitur:
  - Registrasi node baru
  - Monitoring multiple node
  - Notifikasi otomatis

### 2. Server Admin (Telegram Bot)

- Menjalankan bot WhatsApp untuk monitoring
- Terdiri dari:
  - wa.js - Bot untuk registrasi
  - monitor.js - Service monitoring
- Fitur:
  - Registrasi node baru
  - Monitoring multiple node
  - Notifikasi otomatis

## Setup WhatsApp Bot

### 1. Persiapan

- Siapkan nomor WhatsApp baru untuk bot
- Pastikan bisa akses WhatsApp Web

### 2. Jalankan Service

```bash
./start-admin.sh start
```

### 3. Scan QR Code

```bash
# Terminal 1 - Untuk wa.js
tail -f /root/logs/wa.log

# Terminal 2 - Untuk monitor.js
tail -f /root/logs/monitor.log
```

Langkah scan:

1. Buka WhatsApp
2. Klik titik 3 pojok kanan atas
3. Pilih "Perangkat Tertaut"
4. Scan kedua QR Code
5. Tunggu proses auth selesai

### 4. Contoh Format allowlist.json yang akan terjadi selesai register

```json
{
  "6285xxxxxx": {
    "ip": "xxx.xx.xxx.xxx",
    "port": "8088",
    "name": "Server 1",
    "address": "hmpxxxxxxxxxxxxxxxxx"
  }
}
```

## Setup Telegram Bot

### 1. Persiapan

- Siapkan bot baru dari botfather

### 2. edit token bot

pada file `tele.js` dan `monitoring-tele.js` edit bagian `const BOT_TOKEN = 'YOUR_MONITOR_BOT_TOKEN';` menggunakan token yang sudah dibuat

### 2. Jalankan Service

```bash
./start-tele-admin.sh start
```

### 3. Cek logs

```bash
# Terminal 1 - Untuk tele.js
tail -f /root/logs/tele.log

# Terminal 2 - Untuk monitor-tele.js
tail -f /root/logs/monitor-tele.log
```

### 4. Contoh Format allowlist-tele.json yang akan terjadi selesai register

```json
{
  "<id_tele>": {
    "ip": "xxx.xx.xxx.xxx",
    "port": "8088",
    "name": "Server 1",
    "address": "hmpxxxxxxxxxxxxxxxxx"
  }
}
```
