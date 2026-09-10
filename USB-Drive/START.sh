#!/usr/bin/env bash
set -u

# The absolute path to the loader
SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SELF")"
readonly SELF SCRIPT_DIR

readonly X11_DISPLAY="${DISPLAY:-}"
readonly WL_DISPLAY="${WAYLAND_DISPLAY:-}"
readonly IS_RESPAWNED="${SUNTECH_TTY:-}"
readonly NODE_MIN_VERSION="18"
terminal_found="no"

# Do we have a terminal?
if [[ -t 0 || -t 1 || -t 2 ]]; then
    terminal_found="yes"
fi

gui_found="no"

if [[ -n "$X11_DISPLAY" || -n "$WL_DISPLAY" ]]; then
    gui_found="yes"
fi

if [ -n "$IS_RESPAWNED" ]; then
    branch="inline-respawned"
elif [ "$terminal_found" = "yes" ]; then
    branch="inline"
elif [ "$gui_found" = "yes" ]; then
    branch="spawn"
else
    branch="headless"
fi

# Basically if we get here and our mode is "headless" that means we have
# no GUI nor TTY to spawn a process from, so there's no point to spawning
# the server because there's nobody visually manning this session to see
# it.

if [ "$branch" = "headless" ]; then
    printf 'No terminal and no desktop, so there is nothing to show.\n' >&2
    exit 1
fi

# From this point we know we have "some kind of interactive session" so
# we can continue on with our business. Next we need to check that we
# can find the node script we're about to run.

cd -- "$SCRIPT_DIR" || exit 1

if [ ! -f system/server.js ]; then
    printf 'Cannot find system/server.js next to this script.\n' >&2
    exit 1
fi

# Basically, take a wild guess at which terminal emulator the user has on their
# system. Most Linux systems are going to have their default terminal emulator
# symlinked to x-terminal-emulator so this is a safe first option. If it's not
# found, then we try some others.

terminal_program=""

if [ -z "$terminal_program" ] && command -v x-terminal-emulator > /dev/null; then
    terminal_program="x-terminal-emulator"
fi

if [ -z "$terminal_program" ] && command -v lxterminal > /dev/null; then
    terminal_program="lxterminal"
fi

if [ -z "$terminal_program" ] && command -v xterm > /dev/null; then
    terminal_program="xterm"
fi

# If we need to spawn a new process, we also need to make sure that we actually
# have an executable terminal program to run.

if [ "$branch" = "spawn" ] && [ -z "$terminal_program" ]; then
    printf 'No terminal program found, so output will not be visible.\n' >&2
    branch="inline"
fi

# If we have to spawn, then specify that we have done so by setting SUNTECH_TTY
# and re-running the application. This will ensure that don't respawn in the
# next execution.

if [ "$branch" = "spawn" ]; then
    SUNTECH_TTY=1 exec "$terminal_program" -e bash "$SELF"
fi

# Collect every missing dependency before reporting, so the user learns about
# all of them in one run instead of one per attempt.

missing_packages=()

# We need to check if node is actually here to run at all...

if ! command -v node > /dev/null; then
    missing_packages+=("nodejs")
fi

# These four paths are the ones server.js:396 checks with fs.existsSync.
# If you change this list, change that one too.

browser_found="no"

if [ -x /usr/bin/google-chrome ]; then
    browser_found="yes"
fi

if [ -x /usr/bin/chromium ]; then
    browser_found="yes"
fi

if [ -x /usr/bin/chromium-browser ]; then
    browser_found="yes"
fi

if [ -x /opt/pw-browsers/chromium ]; then
    browser_found="yes"
fi

if [ "$browser_found" = "no" ]; then
    missing_packages+=("chromium")
fi

if [ "${#missing_packages[@]}" -gt 0 ]; then
    printf 'This loader needs some things installed first:\n\n'
    printf '    sudo apt install %s\n\n' "${missing_packages[*]}"
    exit 1
fi

# Node exists by this point, so it is safe to ask it for its version.

node_version_raw="$(node -v)"
node_version_number="${node_version_raw#v}"
node_major="${node_version_number%%.*}"

if [ "$node_major" -lt "$NODE_MIN_VERSION" ]; then
    printf 'Node %s or newer is required, but this system has %s.\n' "$NODE_MIN_VERSION" "$node_version_number" >&2
    exit 1
fi

# Everything the loader needs is present. Hand over to the server, which finds
# a free port and opens the arcade in a chrome-less browser window.

printf '\n   SUN TECH UNLIMITED  ///  GAME GRID\n'
printf '   ----------------------------------------------\n'
printf '\n   Leave this window open while you play.\n\n'

# Ctrl-C reaches Node as well, so it stops on its own. Absorbing the signal
# here keeps the shutdown message and the pause below from being skipped.
trap ':' INT

node system/server.js
server_status=$?

printf '\n   The Game Grid has shut down.\n'

# A terminal we opened ourselves closes the instant this script ends, taking
# any error message with it. Hold it open so a human can read what happened.
# A terminal the user was already sitting in needs no such pause.

# Reading the prompt fails immediately when there is no keyboard attached, so
# the server's own exit status is what this script reports, not the read's.

if [ "$branch" = "inline-respawned" ]; then
    printf '\n'
    read -r -p '   Press Return to close. ' _
fi

exit "$server_status"
