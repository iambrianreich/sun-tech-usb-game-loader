#!/usr/bin/env bash
set -u

# Turns a Raspberry Pi desktop into a "minimum viable game loader": stops what
# the games do not need, pins the CPU at full speed, drops the screen to a
# resolution the GPU can fill quickly, then runs START.sh. Everything is put
# back when the game grid closes, or with `off` if that never happened.
#
#   pi-game-mode.sh [run]   tune, launch the Game Grid, restore on exit
#   pi-game-mode.sh on      tune only
#   pi-game-mode.sh off     restore whatever `on` changed
#   pi-game-mode.sh status  show what is running and how the CPU is set
#
# Options: --res WxH  --no-res  --close-browser  --dry-run

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
REPO_DIR="$(dirname -- "$(dirname -- "$SELF")")"
readonly SELF REPO_DIR
readonly LAUNCHER="$REPO_DIR/USB-Drive/START.sh"
readonly STATE_FILE="${XDG_RUNTIME_DIR:-/tmp}/pi-game-mode.state"

# Nothing here is needed to run the Game Grid. NetworkManager, udisks2 (which
# mounts the USB stick), logind and dbus are deliberately absent, and so is
# SSH, so a bad run can always be undone from another machine.
readonly STOP_SERVICES=(wayvnc wayvnc-control bluetooth avahi-daemon ModemManager cups cups-browsed rpcbind nfs-blkmap triggerhappy)

# systemd restarts a service the moment something touches its socket, so the
# sockets have to go first or the services come straight back.
readonly STOP_SOCKETS=(avahi-daemon.socket rpcbind.socket cups.socket)

readonly DEFAULT_RES="1280x720"

dry_run="no"
close_browser="no"
resolution="$DEFAULT_RES"
command_name="run"

# ---------------------------------------------------------------- helpers

say() { printf '   %s\n' "$*"; }

# Runs a command, or only announces it under --dry-run.
act() {
    if [ "$dry_run" = "yes" ]; then
        printf '   [dry-run] %s\n' "$*"
        return 0
    fi
    "$@"
}

record() {
    if [ "$dry_run" = "no" ]; then
        printf '%s\t%s\n' "$1" "$2" >> "$STATE_FILE"
    fi
}

is_active() { systemctl is-active --quiet "$1"; }

# Prints "<output> <WxH> <refresh>" for the first display, or nothing when there
# is no Wayland session to ask.
current_mode() {
    command -v wlr-randr > /dev/null || return 1
    wlr-randr 2> /dev/null | awk '
        /^[^ ]/ && output == "" { output = $1; next }
        /current/ && output != "" {
            print output, $1, $3
            exit
        }'
}

# ---------------------------------------------------------------- on

tune() {
    if [ -f "$STATE_FILE" ]; then
        say "Game mode is already on. Run '$0 off' first."
        return 1
    fi

    if [ "$dry_run" = "no" ]; then
        # Ask for the password once, up front, so it is not a surprise later.
        sudo -v || { say "Need sudo to stop services and set the CPU governor."; return 1; }
        : > "$STATE_FILE"
    fi

    # Your everyday Chromium is a separate instance from the Game Grid's, so it
    # only competes for memory and CPU. Closing it is opt-in: it holds tabs.
    local browser_pids
    browser_pids="$(ps -eo pid=,args= | awk '/\/usr\/lib\/chromium\/chromium/ && !/--type=/ && !/suntech-game-grid/ { print $1 }')"
    if [ -n "$browser_pids" ]; then
        if [ "$close_browser" = "yes" ]; then
            say "Closing your open Chromium."
            # SIGTERM lets it save its session, so the tabs come back later.
            for pid in $browser_pids; do act kill -TERM "$pid"; done
        else
            say "Chromium is already open and will slow the games."
            say "Re-run with --close-browser to close it (tabs are restored next time)."
        fi
    fi

    say "Stopping background services."
    local unit
    for unit in "${STOP_SOCKETS[@]}" "${STOP_SERVICES[@]}"; do
        if is_active "$unit"; then
            record service "$unit"
            act sudo systemctl stop "$unit"
        fi
    done

    say "Closing the desktop panel and wallpaper."
    local pid cmd
    for pid in $(pgrep -u "$UID" -x wf-panel-pi; pgrep -u "$UID" -x pcmanfm); do
        cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
        # pcmanfm is also the file manager window. Only the wallpaper goes.
        case "$cmd" in
            *wf-panel-pi*|*"pcmanfm"*"--desktop"*) ;;
            *) continue ;;
        esac
        record process "$cmd"
        act kill "$pid"
    done

    say "Setting the CPU governor to performance."
    local governor
    governor="$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2> /dev/null)"
    if [ -n "$governor" ] && [ "$governor" != "performance" ]; then
        record governor "$governor"
        if [ "$dry_run" = "yes" ]; then
            act sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor "<<< performance"
        else
            echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null
        fi
    fi

    if [ "$resolution" != "none" ]; then
        local output size refresh
        read -r output size refresh < <(current_mode)
        if [ -z "${output:-}" ]; then
            say "No Wayland display found, so the resolution is untouched."
        elif [ "$size" = "$resolution" ]; then
            say "Screen is already $resolution."
        else
            say "Dropping the screen from $size to $resolution."
            record mode "$output $size@${refresh}Hz"
            act wlr-randr --output "$output" --mode "$resolution"
        fi
    fi

    # Fullscreen alone is not enough: the launcher asks for a 1280x800 window,
    # and Chromium keeps that size even when fullscreen, so on a 1280x720
    # screen the bottom 80 pixels fall off. Pin the size to the screen's.
    local screen_size="$resolution"
    if [ "$screen_size" = "none" ]; then
        screen_size="$(current_mode | awk '{ print $2 }')"
    fi
    # Closing the window, or choosing Quit in the Grid, ends the server, which
    # ends START.sh, which is what triggers the restore below.
    export SUNTECH_QUIT_WITH_WINDOW=1
    export SUNTECH_CHROME_FLAGS="${SUNTECH_CHROME_FLAGS:-} --start-fullscreen"
    if [ -n "$screen_size" ]; then
        SUNTECH_CHROME_FLAGS+=" --window-size=${screen_size/x/,}"
    fi
}

# ---------------------------------------------------------------- off

restore() {
    [ -f "$STATE_FILE" ] || return 0

    say "Putting everything back."
    local kind value output mode
    while IFS=$'\t' read -r kind value; do
        case "$kind" in
            mode)
                read -r output mode <<< "$value"
                wlr-randr --output "$output" --mode "$mode" ;;
            governor)
                echo "$value" | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null ;;
            service)
                sudo systemctl start "$value" ;;
            process)
                setsid -f bash -c "$value" > /dev/null 2>&1 ;;
        esac
    done < "$STATE_FILE"

    rm -f "$STATE_FILE"
}

# ---------------------------------------------------------------- status

status() {
    local freq temp
    freq="$(awk '{ printf "%.0f MHz", $1 / 1000 }' /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2> /dev/null)"
    temp="$(vcgencmd measure_temp 2> /dev/null | cut -d= -f2)"

    say "Game mode : $([ -f "$STATE_FILE" ] && echo ON || echo off)"
    say "Governor  : $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2> /dev/null) at ${freq:-?}"
    say "Temp      : ${temp:-?}   throttled: $(vcgencmd get_throttled 2> /dev/null | cut -d= -f2)"
    say "Memory    : $(free -m | awk '/^Mem:/ { print $7 " MB available of " $2 " MB" }')"
    say "Load      : $(cut -d' ' -f1-3 /proc/loadavg)"
    say "Display   : $(current_mode | awk '{ print $2 " @ " $3 }')"
    say ""
    say "Services that game mode stops, and are still running:"
    local unit any="no"
    for unit in "${STOP_SOCKETS[@]}" "${STOP_SERVICES[@]}"; do
        if is_active "$unit"; then say "  $unit"; any="yes"; fi
    done
    [ "$any" = "yes" ] || say "  (none)"
    say ""
    say "Busiest processes:"
    ps -eo pcpu,rss,comm --sort=-pcpu | awk 'NR > 1 && NR <= 6 { printf "     %5s%%  %4d MB  %s\n", $1, $2 / 1024, $3 }'
}

# ---------------------------------------------------------------- main

while [ $# -gt 0 ]; do
    case "$1" in
        run|on|off|status) command_name="$1" ;;
        --dry-run)       dry_run="yes" ;;
        --close-browser) close_browser="yes" ;;
        --no-res)        resolution="none" ;;
        --res)           shift; resolution="${1:-}" ;;
        -h|--help)       sed -n '3,15p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)               say "Unknown option: $1"; exit 2 ;;
    esac
    shift
done

if [ "$resolution" != "none" ] && ! [[ "$resolution" =~ ^[0-9]+x[0-9]+$ ]]; then
    say "--res needs a size like 1280x720."
    exit 2
fi

case "$command_name" in
    status) status ;;
    off)    restore ;;
    on)     tune ;;
    run)
        if [ ! -x "$LAUNCHER" ]; then
            say "Cannot find $LAUNCHER"
            exit 1
        fi
        tune || exit 1
        # Restore on every way out: normal exit, Ctrl-C, or the window closing.
        trap restore EXIT
        trap 'exit 130' INT TERM HUP
        [ "$dry_run" = "yes" ] && { say "[dry-run] would now run $LAUNCHER with SUNTECH_CHROME_FLAGS=\"${SUNTECH_CHROME_FLAGS# }\""; exit 0; }
        "$LAUNCHER"
        ;;
esac
