#!/bin/bash

LOG_FILE="/root/.humanode/workspaces/default/tunnel/logs.txt"
TUNNEL_CMD="/root/.humanode/workspaces/default/humanode-websocket-tunnel"

# Membuat direktori log jika belum ada
mkdir -p "$(dirname "$LOG_FILE")"

log_message() {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%S.%NZ')] $1" | tee -a "$LOG_FILE"
}

start_tunnel() {
    log_message "Starting websocket tunnel..."
    
    # Jalankan tunnel dan pipe output ke log file
    $TUNNEL_CMD 2>&1 | while IFS= read -r line; do
        log_message "$line"
        
        # Cek jika ada error
        if echo "$line" | grep -q "error while proxying\|sending stopped by peer\|error 255"; then
            log_message "Error detected, restarting tunnel..."
            return 1
        fi
    done
}

# Fungsi untuk cleanup saat script dihentikan
cleanup() {
    log_message "Cleaning up..."
    pkill -f "humanode-websocket-tunnel"
    exit 0
}

# Register signal handlers
trap cleanup SIGTERM SIGINT

# Loop utama
while true; do
    start_tunnel
    log_message "Tunnel stopped or error detected. Waiting 5 seconds before restart..."
    sleep 5
done
