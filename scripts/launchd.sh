#!/usr/bin/env bash
#
# Keep the daemon running: install, uninstall, status.
#
#   scripts/launchd.sh install
#   scripts/launchd.sh status
#   scripts/launchd.sh uninstall
#
# ## Why there is no start button
#
# `KeepAlive` makes the daemon a thing that is *always supposed to be up* —
# restarted if it crashes, started again at login, brought back after sleep.
# What an operator actually controls is therefore not whether the process
# exists but whether it is taking work, which is `lingtai pause` and `lingtai resume`
# (doc/decisions/0013-daemon-hosts-the-work.md).
#
# That is what let the UI stay a controller instead of a process manager. A web
# server spawning and killing a child leaves the child orphaned when the server
# dies, or takes it down mid-run — and mid-run here means a paid agent, a
# worktree and a claim.
#
# ## The plist is generated, never committed
#
# It has to carry absolute paths — to this checkout, to `node`, to the log
# directory — and those differ per machine. A committed plist would be one
# person's paths pretending to be configuration.
set -euo pipefail

LABEL="ai.nextloom.lingtai.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="${LINGTAI_HOME:-$HOME/.lingtai}/logs"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^#//;s/^ //'
  exit 2
}

install_agent() {
  local node
  node="$(command -v node || true)"
  if [ -z "$node" ]; then
    echo "no node on PATH — launchd needs its absolute path" >&2
    exit 1
  fi

  mkdir -p "$LOGS" "$(dirname "$PLIST")"

  # launchd starts a job with almost no environment: no PATH worth the name, no
  # HOME on some paths, nothing from a shell profile. Every one of these is
  # something the daemon actually needs — `git` and `pnpm` for a run, HOME for
  # the credentials the runtime reads, and USER because the macOS keychain
  # looks it up by account name. That last one cost a run: without it Claude
  # Code reported "Not logged in" with a valid subscription.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$ROOT/apps/cli/src/lingtai.ts</string>
    <string>daemon</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>RunAtLoad</key>
  <true/>

  <!-- The whole point. Crash, logout, sleep — it comes back. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Long enough that a crash loop does not spin. Short enough that a
       restart after a transient database blip is not a coffee break. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$USER</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOGS/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGS/daemon.err</string>
</dict>
</plist>
PLIST_EOF

  # `bootout` first so re-installing is not a special case. It fails when the
  # job is not loaded, which is fine and is why the failure is swallowed.
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST"

  echo "installed $LABEL"
  echo "  plist   $PLIST"
  echo "  logs    $LOGS/daemon.log"
  echo
  echo "It is taking work. To stop it doing that without stopping the process:"
  echo "  pnpm lingtai pause \"why\""
}

uninstall_agent() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL (logs kept in $LOGS)"
}

status_agent() {
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    launchctl print "gui/$UID/$LABEL" | grep -E "state|pid|last exit" || true
  else
    echo "not loaded"
  fi
  echo
  # The authority on whether it is *working*, as opposed to merely running.
  # launchd knows the process exists; only the beacon knows it is beating.
  (cd "$ROOT" && pnpm --silent lingtai doctor 2>/dev/null | grep -A1 "daemon: liveness") || true
}

case "${1:-}" in
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  status) status_agent ;;
  *) usage ;;
esac
