#!/bin/bash

# Lokasi file log
LOG_DIR="/root/logs"
mkdir -p "$LOG_DIR"

# Fungsi untuk logging
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_DIR/startup-tele.log"
}

# Fungsi untuk memeriksa apakah proses sudah berjalan
is_process_running() {
    pgrep -f "$1" > /dev/null
}

# Fungsi untuk menghentikan proses jika sudah berjalan
stop_if_running() {
    local process_name="$1"
    if is_process_running "$process_name"; then
        log_message "Menghentikan $process_name yang sedang berjalan..."
        pkill -f "$process_name"
        sleep 2
    fi
}

# Fungsi untuk memulai Telegram bot
start_tele_bot() {
    log_message "Memulai Telegram Bot..."
    nohup node tele.js > "$LOG_DIR/tele.log" 2>&1 &
    sleep 3
    
    if is_process_running "tele.js"; then
        log_message "Telegram Bot berhasil dijalankan"
    else
        log_message "GAGAL menjalankan Telegram Bot"
        return 1
    fi
}

# Fungsi untuk memulai monitor checker
start_monitor_tele() {
    log_message "Memulai monitor Checker..."
    nohup node monitor-tele.js > "$LOG_DIR/monitor-tele.log" 2>&1 &
    sleep 3
    
    if is_process_running "monitor-tele.js"; then
        log_message "monitor tele berhasil dijalankan"
    else
        log_message "GAGAL menjalankan monitor"
        return 1
    fi
}



# Fungsi untuk memeriksa status semua layanan
check_services() {
    log_message "Memeriksa status layanan..."
    
    if is_process_running "tele.js"; then
        echo "Telegram Bot: Running"
    else
        echo "Telegram Bot: Stopped"
    fi
    
    if is_process_running "monitor-tele.js"; then
        echo "monitor: Running"
    else
        echo "monitor: Stopped"
    fi
}

# Fungsi untuk menghentikan semua layanan
stop_all() {
    log_message "Menghentikan semua layanan..."
    stop_if_running "tele.js"
    stop_if_running "monitor-tele.js"
    log_message "Semua layanan dihentikan"
}

# Main script
case "$1" in
    start)
        if [ -z "$2" ]; then
            log_message "Memulai semua layanan..."
            stop_all
            start_tele_bot
            sleep 2
            start_monitor_tele
        else
            shift
            log_message "Memulai service: $@"
            for service in $@; do
                case "$service" in
                    tele)
                        start_tele_bot
                        ;;
                    monitor-tele)
                        start_monitor_tele
                        ;;

                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: tele|monitor-tele"
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
                    tele)
                        stop_if_running "tele.js"
                        ;;
                    monitor-tele)
                        stop_if_running "monitor-tele.js"
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: tele|monitor"
                        ;;
                esac
            done
        fi
        check_services
        ;;
        
    restart)
        if [ -z "$2" ]; then
            stop_all
            sleep 2
            $0 start
        else
            shift
            log_message "Melakukan restart service: $@"
            for service in $@; do
                case "$service" in
                    tele|monitor-tele)
                        $0 stop $service
                        sleep 2
                        $0 start $service
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: tele|monitor"
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
        echo "  status              - Cek status semua service"
        echo ""
        echo "Services: tele|monitor"
        exit 1
        ;;
esac

exit 0
