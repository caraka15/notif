#!/bin/bash

# Lokasi file log
LOG_DIR="/root/logs"
mkdir -p "$LOG_DIR"
# Pastikan direktori tempat skrip Node.js berada adalah direktori saat ini
# atau tentukan path absolut ke skrip Node.js Anda.
# Contoh: SCRIPT_DIR="/root/notif"
SCRIPT_DIR=$(pwd) # Menggunakan direktori saat ini sebagai default

# Fungsi untuk logging
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_DIR/startup.log"
}

# Fungsi untuk memeriksa apakah proses sudah berjalan
is_process_running() {
    pgrep -f "$1" > /dev/null
}

# Fungsi untuk menghentikan proses jika sudah berjalan
stop_if_running() {
    local process_name_pattern="$1" # Ini akan menjadi pola untuk pgrep/pkill, misal "node wa.js"
    if is_process_running "$process_name_pattern"; then
        log_message "Menghentikan proses yang cocok dengan '$process_name_pattern'..."
        pkill -f "$process_name_pattern"
        sleep 2 # Beri waktu agar proses benar-benar berhenti
        if is_process_running "$process_name_pattern"; then
            log_message "Gagal menghentikan '$process_name_pattern' dengan pkill. Mencoba kill -9..."
            pkill -9 -f "$process_name_pattern"
            sleep 1
        fi
    else
        log_message "Tidak ada proses yang cocok dengan '$process_name_pattern' yang berjalan."
    fi
}

# Fungsi untuk memulai WhatsApp bot
start_wa_bot() {
    log_message "Memulai WhatsApp Bot (wa.js)..."
    # Pastikan Anda berada di direktori yang benar atau gunakan path absolut
    nohup node "$SCRIPT_DIR/wa.js" > "$LOG_DIR/wa.log" 2>&1 &
    sleep 3
    
    if is_process_running "node $SCRIPT_DIR/wa.js"; then
        log_message "WhatsApp Bot (wa.js) berhasil dijalankan"
    else
        log_message "GAGAL menjalankan WhatsApp Bot (wa.js)"
        return 1
    fi
}

# Fungsi untuk memulai monitor checker (monitor-beta.js)
start_monitor_js() { # Mengganti nama fungsi agar lebih spesifik
    log_message "Memulai Monitor Asli (monitor-beta.js)..."
    nohup node "$SCRIPT_DIR/monitor-beta.js" > "$LOG_DIR/monitor-beta.log" 2>&1 &
    sleep 3
    
    if is_process_running "node $SCRIPT_DIR/monitor-beta.js"; then
        log_message "Monitor Asli (monitor-beta.js) berhasil dijalankan"
    else
        log_message "GAGAL menjalankan Monitor Asli (monitor-beta.js)"
        return 1
    fi
}

# Fungsi untuk memulai Web Server (web_server.js)
start_web_server() {
    log_message "Memulai Web Server (web_server.js)..."
    nohup node "$SCRIPT_DIR/web_server.js" > "$LOG_DIR/web_server.log" 2>&1 &
    sleep 3
    
    if is_process_running "node $SCRIPT_DIR/web_server.js"; then
        log_message "Web Server (web_server.js) berhasil dijalankan"
    else
        log_message "GAGAL menjalankan Web Server (web_server.js)"
        return 1
    fi
}

# Fungsi untuk memulai Epoch Monitor (poch.js)
start_epoch_monitor() { # Menggunakan nama file poch.js
    log_message "Memulai Epoch Monitor (poch.js)..."
    nohup node "$SCRIPT_DIR/poch.js" > "$LOG_DIR/poch.log" 2>&1 &
    sleep 3
    
    if is_process_running "node $SCRIPT_DIR/poch.js"; then
        log_message "Epoch Monitor (poch.js) berhasil dijalankan"
    else
        log_message "GAGAL menjalankan Epoch Monitor (poch.js)"
        return 1
    fi
}


# Fungsi untuk memeriksa status semua layanan
check_services() {
    log_message "Memeriksa status layanan..."
    
    if is_process_running "node $SCRIPT_DIR/wa.js"; then
        echo "WhatsApp Bot (wa.js): Running"
    else
        echo "WhatsApp Bot (wa.js): Stopped"
    fi
    
    if is_process_running "node $SCRIPT_DIR/monitor-beta.js"; then
        echo "Monitor Asli (monitor-beta.js): Running"
    else
        echo "Monitor Asli (monitor-beta.js): Stopped"
    fi

    if is_process_running "node $SCRIPT_DIR/web_server.js"; then
        echo "Web Server (web_server.js): Running"
    else
        echo "Web Server (web_server.js): Stopped"
    fi

    if is_process_running "node $SCRIPT_DIR/poch.js"; then
        echo "Epoch Monitor (poch.js): Running"
    else
        echo "Epoch Monitor (poch.js): Stopped"
    fi
}

# Fungsi untuk menghentikan semua layanan
stop_all() {
    log_message "Menghentikan semua layanan..."
    stop_if_running "node $SCRIPT_DIR/wa.js"
    stop_if_running "node $SCRIPT_DIR/monitor-beta.js"
    stop_if_running "node $SCRIPT_DIR/web_server.js"
    stop_if_running "node $SCRIPT_DIR/poch.js"
    log_message "Semua layanan dihentikan"
}

# Main script
case "$1" in
    start)
        if [ -z "$2" ]; then
            log_message "Memulai semua layanan..."
            stop_all # Hentikan dulu semua yang mungkin berjalan
            start_wa_bot
            sleep 2
            start_monitor_js # Nama fungsi yang diubah
            sleep 2
            start_web_server
            sleep 2
            start_epoch_monitor
        else
            shift
            log_message "Memulai service: $@"
            for service in $@; do
                case "$service" in
                    wa)
                        stop_if_running "node $SCRIPT_DIR/wa.js"
                        start_wa_bot
                        ;;
                    monitor) # Ini merujuk ke monitor-beta.js yang lama
                        stop_if_running "node $SCRIPT_DIR/monitor-beta.js"
                        start_monitor_js 
                        ;;
                    web)
                        stop_if_running "node $SCRIPT_DIR/web_server.js"
                        start_web_server
                        ;;
                    poch)
                        stop_if_running "node $SCRIPT_DIR/poch.js"
                        start_epoch_monitor
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: wa | monitor | web | poch"
                        ;;
                esac
                sleep 2
            done
        fi
        sleep 2
        check_services
        log_message "Selesai memulai layanan"
        ;;
        
    stop)
        if [ -z "$2" ]; then
            stop_all
        else
            shift
            log_message "Menghentikan service: $@"
            for service in $@; do
                case "$service" in
                    wa)
                        stop_if_running "node $SCRIPT_DIR/wa.js"
                        ;;
                    monitor)
                        stop_if_running "node $SCRIPT_DIR/monitor-beta.js"
                        ;;
                    web)
                        stop_if_running "node $SCRIPT_DIR/web_server.js"
                        ;;
                    poch)
                        stop_if_running "node $SCRIPT_DIR/poch.js"
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: wa | monitor | web | poch"
                        ;;
                esac
            done
        fi
        check_services
        ;;
        
    restart)
        if [ -z "$2" ]; then
            log_message "Melakukan restart semua layanan..."
            stop_all
            sleep 2
            # Panggil start tanpa argumen untuk memulai semua
            $0 start 
        else
            shift
            log_message "Melakukan restart service: $@"
            for service in $@; do
                case "$service" in
                    wa|monitor|web|poch)
                        log_message "Melakukan restart $service..."
                        $0 stop $service
                        sleep 2
                        $0 start $service
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: wa | monitor | web | poch"
                        ;;
                esac
            done
        fi
        check_services
        log_message "Selesai restart service"
        ;;
        
    status)
        check_services
        ;;
        
    *)
        echo "Penggunaan: $0 COMMAND [SERVICE...]"
        echo "Commands:"
        echo "  start [service...]   - Memulai semua atau service tertentu"
        echo "  stop [service...]    - Menghentikan semua atau service tertentu"
        echo "  restart [service...] - Restart semua atau service tertentu"
        echo "  status               - Cek status semua service"
        echo ""
        echo "Services: wa | monitor | web | poch"
        exit 1
        ;;
esac

exit 0
