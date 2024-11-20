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

# Fungsi untuk memulai server API
start_server() {
    log_message "Memulai server API..."
    nohup node server.js > "$LOG_DIR/server.log" 2>&1 &
    sleep 3
    
    if is_process_running "server.js"; then
        log_message "Server API berhasil dijalankan"
    else
        log_message "GAGAL menjalankan Server API"
        return 1
    fi
}

# Fungsi untuk memulai websocket tunnel
start_ws_tunnel() {
    log_message "Memulai Websocket Tunnel Manager..."
    nohup ./ws.sh > "$LOG_DIR/ws.log" 2>&1 &
    sleep 3
    
    if is_process_running "ws.sh"; then
        log_message "Websocket Tunnel Manager berhasil dijalankan"
    else
        log_message "GAGAL menjalankan Websocket Tunnel Manager"
        return 1
    fi
}

# Fungsi untuk memeriksa status layanan
check_services() {
    log_message "Memeriksa status layanan..."
    
    if is_process_running "server.js"; then
        echo "Server API: Running"
    else
        echo "Server API: Stopped"
    fi
    
    if is_process_running "ws.sh"; then
        echo "Websocket Tunnel: Running"
    else
        echo "Websocket Tunnel: Stopped"
    fi
}

# Fungsi untuk menghentikan semua layanan
stop_all() {
    log_message "Menghentikan semua layanan..."
    stop_if_running "server.js"
    stop_if_running "ws.sh"
    log_message "Semua layanan dihentikan"
}

# Main script
case "$1" in
    start)
        if [ -z "$2" ]; then
            log_message "Memulai semua layanan..."
            stop_all
            start_ws_tunnel
            sleep 2
            start_server
        else
            shift
            log_message "Memulai service: $@"
            for service in $@; do
                case "$service" in
                    server)
                        start_server
                        ;;
                    ws)
                        start_ws_tunnel
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: server|ws"
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
                    server)
                        stop_if_running "server.js"
                        ;;
                    ws)
                        stop_if_running "ws.sh"
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: server|ws"
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
                    server)
                        stop_if_running "server.js"
                        sleep 2
                        start_server
                        ;;
                    ws)
                        stop_if_running "ws.sh"
                        sleep 2
                        start_ws_tunnel
                        ;;
                    *)
                        echo "Service tidak dikenal: $service"
                        echo "Gunakan: server|ws"
                        ;;
                esac
            done
        fi
        sleep 2
        check_services
        log_message "Selesai melakukan restart layanan"
        ;;

    status)
        check_services
        ;;

    *)
        echo "Penggunaan: $0 {start|stop|restart|status} [service]"
        echo "Service yang tersedia: server, ws"
        ;;
esac