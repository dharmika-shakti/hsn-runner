FROM node:20

# Install Xvfb, VNC, window manager, and Chrome dependencies
RUN apt-get update && \
    apt-get install -y \
    xvfb x11-utils \
    tightvncserver novnc websockify \
    openbox x11-apps xterm \
    fonts-dejavu \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libicu63 \
    libjpeg-turbo-progs \
    libjpeg62-turbo \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libpng16-16 \
    libpulse0 \
    libsecret-1-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxinerama1 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project files
COPY package*.json ./
RUN npm install

# Install Chrome for Puppeteer
RUN npx puppeteer browsers install chrome

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
