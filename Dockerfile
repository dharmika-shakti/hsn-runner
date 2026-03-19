FROM node:20

# Install Xvfb, VNC, window manager and all Chrome dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    xvfb \
    x11-utils \
    openbox \
    tightvncserver \
    novnc \
    websockify \
    x11-apps \
    xterm \
    fonts-dejavu \
    ca-certificates \
    chromium-browser \
    chromium-sandbox && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project files
COPY package*.json ./
RUN npm install

# Install Chrome for Puppeteer (or use chromium if available)
RUN npx puppeteer browsers install chrome || true

# Copy rest of the project
COPY . .

# Make start script executable
RUN chmod +x start.sh

# Set environment variables
ENV DISPLAY=:99
ENV NODE_ENV=production

# Expose ports: 3070 (HSN runner), 5900 (VNC), 6080 (noVNC web)
EXPOSE 3070 5900 6080

# Start the application
CMD ["bash", "start.sh"]
