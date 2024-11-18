# Humanode Monitor System

Sistem untuk monitoring node Humanode dengan fitur web API dan notifikasi WhatsApp. Mengubah bioauth dan websocket tunnel menjadi endpoint HTTP yang bisa diakses secara remote, dilengkapi dengan monitoring status dan balance.

## Daftar Isi

1. [Cara Kerja Sistem](#cara-kerja-sistem)
2. [Instalasi](#instalasi)
3. [Setup Web API](#setup-web-api)
4. [Setup WhatsApp Bot](#setup-whatsapp-bot)
5. [Command Service](#command-service)
6. [API Documentation](#api-documentation)
7. [Monitoring & Notifikasi](#monitoring--notifikasi)
8. [Troubleshooting](#troubleshooting)

## Cara Kerja Sistem

### 1. Server User (Web API)

- Membuat interface HTTP untuk akses bioauth dan websocket
- Terdiri dari:
  - server.js - API endpoint
  - ws.sh - WebSocket tunnel
- Endpoint yang disediakan:
  ```
  GET /cek  - Status bioauth dan sisa waktu
  GET /auth - Link autentikasi
  GET /     - Web dashboard
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

## Instalasi

### 1. Clone Repository

```bash
git clone https://github.com/caraka15/notif
cd notif
```

### 2. Install Dependencies

```bash
# NodeJS dependencies
npm install

# System dependencies
sudo apt-get install -y \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libxkbcommon-dev \
    libxkbcommon-x11-dev
```

### 3. Setup Permission

```bash
chmod +x start-admin.sh start-user.sh ws.sh
```

### 4. Struktur Directory

```
/root/notif/
├── config/
│   └── allowlist.json    # Konfigurasi server
├── monitor.js           # Service monitoring
├── server.js           # Web API server
├── wa.js              # WhatsApp bot
├── ws.sh             # WebSocket tunnel
├── start-admin.sh    # Script admin service
└── start-user.sh     # Script user service

/root/logs/
├── startup.log    # Log startup service
├── wa.log        # Log WhatsApp bot
├── monitor.log   # Log monitoring
├── server.log    # Log API server
└── ws.log        # Log websocket
```

## Setup Web API

### 1. Jalankan Service

```bash
cd /root/notif
./start-user.sh start
```

### 2. Cek Port dan Status

```bash
tail -f /root/logs/server.log
```

Format response /cek:

```json
{
  "status": {
    "jsonrpc": "2.0",
    "result": {
      "Active": {
        "expires_at": 1732212360003
      }
    },
    "id": 1,
    "remaining_time": {
      "hours": 101,
      "minutes": 27,
      "formatted": "101 jam 27 menit"
    }
  },
  "auth": {
    "success": true,
    "url": "https://webapp.mainnet.stages.humanode.io/humanode/wss%3A%2F%2Fxxxx.ws1.htunnel.app",
    "raw_wss": "wss://xxxx.ws1.htunnel.app"
  }
}
```

### 3. Register ke Bot Admin

Chat ke nomor: 081932266177

```
1. Kirim: #register
2. Masukkan IP server
3. Masukkan port (dari logs)
4. Masukkan nama server
5. Masukkan address HMND (opsional)
6. Konfirmasi dengan 'ya'
```

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

## Command Service

### Server User (Web API)

```bash
# Start Service
./start-user.sh start          # Start semua
./start-user.sh start server   # Start API saja
./start-user.sh start ws       # Start WebSocket saja

# Stop Service
./start-user.sh stop           # Stop semua
./start-user.sh stop server    # Stop API saja
./start-user.sh stop ws        # Stop WebSocket saja

# Restart Service
./start-user.sh restart        # Restart semua
./start-user.sh restart server # Restart API saja
./start-user.sh restart ws     # Restart WebSocket saja

# Status
./start-user.sh status
```

### Server Admin (WhatsApp Bot)

```bash
# Start Service
./start-admin.sh start         # Start semua
./start-admin.sh start wa      # Start bot saja
./start-admin.sh start monitor # Start monitor saja

# Stop Service
./start-admin.sh stop          # Stop semua
./start-admin.sh stop wa       # Stop bot saja
./start-admin.sh stop monitor  # Stop monitor saja

# Restart Service
./start-admin.sh restart         # Restart semua
./start-admin.sh restart wa      # Restart bot saja
./start-admin.sh restart monitor # Restart monitor saja

# Status
./start-admin.sh status
```

## Command WhatsApp Bot

```
#register - Daftar node baru
#cek      - Cek status bioauth
#link     - Dapatkan link autentikasi
#web      - Tampilkan link dashboard
#bantuan  - Tampilkan daftar perintah
```

## Monitoring & Notifikasi

Bot akan mengirim notifikasi untuk:

1. Status Bioauth:
   - Status inactive
   - Warning 30 menit
   - Warning 5 menit
2. Balance Update (jika address terdaftar):
   - Format: "💰 _Balance Update_ \n\n*Server:* Server 1\n*Address:* hmps...\n*Saldo:* xx HMND = Rp. 150.000"

## Troubleshooting

### 1. Web API Error

Cek error di logs:

```bash
tail -f /root/logs/server.log  # API server
tail -f /root/logs/ws.log      # WebSocket
```

Solusi umum:

```bash
# Restart specific service
./start-user.sh restart server
./start-user.sh restart ws

# Restart all
./start-user.sh restart
```

### 2. WhatsApp Bot Error

Cek error di logs:

```bash
tail -f /root/logs/wa.log      # WhatsApp bot
tail -f /root/logs/monitor.log # Monitoring
```

Solusi umum:

```bash
# Restart specific service
./start-admin.sh restart wa
./start-admin.sh restart monitor

# Restart all
./start-admin.sh restart
```

### 3. QR Code Issues

- Clear terminal: `clear`
- Tunggu 20-30 detik untuk QR baru
- Restart service jika masih error
- Pastikan folder .wwebjs*auth*\* ada dan writable

### 4. Connection Issues

```bash
# Cek status service
./start-user.sh status
./start-admin.sh status

# Cek logs real-time
tail -f /root/logs/*.log

# Restart jika perlu
./start-user.sh restart
./start-admin.sh restart
```

### 5. Permission Issues

```bash
# Set permission
chmod +x *.sh
chmod -R 755 /root/notif
chmod -R 755 /root/logs

# Cek log permission
ls -la /root/logs/
```
