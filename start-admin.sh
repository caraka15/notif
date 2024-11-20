#!/bin/bash

# Lokasi file log
LOG_DIR="/root/logs"
mkdir -p "$LOG_DIR"

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
    local process_name="$1"
    if is_process_running "$process_name"; then
        log_message "Menghentikan $process_name yang sedang berjalan..."
        pkill -f "$process_name"
        sleep 2
    fi
}

# Fungsi untuk memulai WhatsApp bot
start_wa_bot() {
    log_message "Memulai WhatsApp Bot..."
    nohup node wa.js > "$LOG_DIR/wa.log" 2>&1 &
    sleep 3
    
    if is_process_running "wa.js"; then
        log_message "WhatsApp Bot berhasil dijalankan"
    else
        log_message "GAGAL menjalankan WhatsApp Bot"
        return 1
    fi
}

# Fungsi untuk memulai monitor checker
start_monitor() {
    log_message "Memulai monitor Checker..."
    nohup node monitor.js > "$LOG_DIR/monitor.log" 2>&1 &
    sleep 3
    
    if is_process_running "monitor.js"; then
        log_message "monitor berhasil dijalankan"
    else
        log_message "GAGAL menjalankan monitor"
        return 1
    fi
}



# Fungsi untuk memeriksa status semua layanan
check_services() {
    log_message "Memeriksa status layanan..."
    
    if is_process_running "wa.js"; then
        echo "WhatsApp Bot: Running"
    else
        echo "WhatsApp Bot: Stopped"
    fi
    
    if is_process_running "monitor.js"; then
        echo "monitor: Running"
    else
        echo "monitor: Stopped"
    fi
}

# Fungsi untuk menghentikan semua layanan
stop_all() {
    log_message "Menghentikan semua layanan..."
    stop_if_running "wa.js"
    stop_if_running "monitor.js"
    log_message "Semua layanan dihentikan"
}

# Main script
case "$1" in
    start)
        if [ -z "$2" ]; then
            log_message "Memulai semua layanan..."
            stop_all
            start_wa_bot
            sleep 2
            start_monitor
        else
            shift
            log_message "Memulai service: $@"
            for service in $@; do
                case "$service" in
                    wa)
                        start_wa_bot
                        ;;
                    monitor)
                        start_monitor
                        ;;

                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: wa|monitor"
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
                        stop_if_running "wa.js"
                        ;;
                    monitor)
                        stop_if_running "monitor.js"
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: wa|monitor"
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
                    wa|monitor)
                        $0 stop $service
                        sleep 2
                        $0 start $service
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: wa|monitor"
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
        echo "Services: wa|monitor"
        exit 1
        ;;
esac

exit 0
