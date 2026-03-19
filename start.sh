#!/bin/bash
set -e

echo "Starting Xvfb virtual display..."
Xvfb :99 -screen 0 1024x768x24 > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
echo "Xvfb started with PID $XVFB_PID"

# Wait for Xvfb to be ready
sleep 2

export DISPLAY=:99

echo "Installing Chrome..."
npx puppeteer browsers install chrome

echo "Running test..."
node test-chrome-path.js

echo "Starting HSN Runner server..."
node index.js

# Keep script running
wait $XVFB_PID
