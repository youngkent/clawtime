#!/bin/bash
# Graceful restart - waits for pending responses before restarting

RUNID_FILE="$HOME/.clawtime/pending-runids.json"
MAX_WAIT=30

echo "[Restart] Checking for pending responses..."

# Wait for pending runIds to clear
waited=0
while [ $waited -lt $MAX_WAIT ]; do
  if [ ! -f "$RUNID_FILE" ]; then
    break
  fi
  
  count=$(cat "$RUNID_FILE" 2>/dev/null | grep -o '"' | wc -l)
  count=$((count / 4))  # Each runId has 4 quotes (key + value pair)
  
  if [ "$count" -eq 0 ] || [ "$(cat "$RUNID_FILE")" = "{}" ]; then
    break
  fi
  
  echo "[Restart] Waiting for $count pending response(s)..."
  sleep 2
  waited=$((waited + 2))
done

if [ $waited -ge $MAX_WAIT ]; then
  echo "[Restart] Timeout after ${MAX_WAIT}s, proceeding anyway"
fi

echo "[Restart] Restarting ClawTime..."
systemctl --user restart clawtime

sleep 1
systemctl --user status clawtime | head -3
