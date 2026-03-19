#!/bin/bash
set -e

echo "=== HSN Runner with VNC Startup ==="

# Set required environment variables
export USER=root
export HOME=/root
mkdir -p /root/.vnc

# Start Xvfb virtual display
echo "Starting Xvfb virtual display on :99..."
Xvfb :99 -screen 0 1280x800x24 > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
echo "✓ Xvfb PID: $XVFB_PID"

sleep 3

export DISPLAY=:99
echo "✓ DISPLAY=$DISPLAY"

# Start window manager (openbox)
echo "Starting window manager (Openbox)..."
openbox --replace > /tmp/openbox.log 2>&1 &
OPENBOX_PID=$!
echo "✓ Openbox PID: $OPENBOX_PID"

sleep 2

# Set VNC password (empty password for passwordless access)
echo "" | vncpasswd -f > /root/.vnc/passwd 2>/dev/null || true
chmod 600 /root/.vnc/passwd

# Start VNC server
echo "Starting VNC server on port 5900..."
vncserver :99 -geometry 1280x800 -depth 24 -nolisten tcp -SecurityTypes None 2>&1 | grep -v "Warning" || true
echo "✓ VNC server started"

sleep 2

# Start noVNC web server
echo "Starting noVNC web interface on port 6080..."
websockify --web=/usr/share/novnc 6080 localhost:5900 > /tmp/novnc.log 2>&1 &
NOVNC_PID=$!
echo "✓ noVNC PID: $NOVNC_PID"
echo "✓ Access browser at: http://localhost:6080/vnc.html"

sleep 2

echo ""
echo "=== Starting HSN Runner Server ==="
node index.js &
HSN_PID=$!

# Keep running
wait

