#!/bin/bash
# Launch Agent Hub in the background (no terminal needed after double-click)
cd "$(dirname "$0")"

# Install deps if missing
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Launch Electron as a detached process
nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &
disown

echo "Agent Hub is running! You can close this terminal."
