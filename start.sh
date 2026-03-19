#!/bin/bash
set -e

echo "=== HSN Runner with VNC Startup ==="

# Create VNC home directory
mkdir -p /root/.vnc

# Start Xvfb virtual display
echo "Starting Xvfb virtual display on :99..."
Xvfb :99 -screen 0 1280x800x24 > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
echo "✓ Xvfb PID: $XVFB_PID"

sleep 2

export DISPLAY=:99
echo "✓ DISPLAY=$DISPLAY"

# Start VNC server (password-less for easier access)
echo "Starting VNC server on port 5900..."
vncserver :99 -geometry 1280x800 -depth 24 -nolisten tcp 2>&1 | grep -v "Warning" || true
echo "✓ VNC server started"

# Start noVNC web server (web-based VNC viewer)
echo "Starting noVNC web interface on port 6080..."
websockify --web=/usr/share/novnc 6080 localhost:5999 > /tmp/novnc.log 2>&1 &
NOVNC_PID=$!
echo "✓ noVNC PID: $NOVNC_PID"
echo "✓ Access browser at: http://localhost:6080/vnc.html"

sleep 2

echo ""
echo "=== Starting HSN Runner Server ==="
node index.js &
HSN_PID=$!

# Wait for any process to exit
wait $XVFB_PID $NOVNC_PID $HSN_PID

