#!/bin/bash
# Wait for pending responses before allowing shutdown
# Used by systemd ExecStop to ensure no messages are lost

RUNID_FILE="$HOME/.clawtime/pending-runids.json"
TIMEOUT=60
ELAPSED=0

while [ $ELAPSED -lt $TIMEOUT ]; do
  # Check if file exists and has pending runIds
  if [ ! -f "$RUNID_FILE" ]; then
    echo "[wait-pending] No pending file, safe to stop"
    exit 0
  fi
  
  COUNT=$(cat "$RUNID_FILE" 2>/dev/null | grep -o '"' | wc -l)
  COUNT=$((COUNT / 4))  # Each runId has 4 quotes (key + value)
  
  if [ "$COUNT" -eq 0 ]; then
    echo "[wait-pending] No pending responses, safe to stop"
    exit 0
  fi
  
  echo "[wait-pending] Waiting for $COUNT pending response(s)... ($ELAPSED/$TIMEOUT sec)"
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "[wait-pending] Timeout reached, forcing stop"
exit 0
