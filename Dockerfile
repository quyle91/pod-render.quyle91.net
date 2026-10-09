FROM node:20-bookworm-slim

# Install system dependencies if required for canvas/fonts/graphics
RUN apt-get update && apt-get install -y \
    curl \
    fontconfig \
    fonts-dejavu \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production and development dependencies
RUN npm install

# Copy application source
COPY . .

# Install custom fonts into system fontconfig
RUN if [ -d "/app/src/assets/fonts" ]; then \
        mkdir -p /usr/local/share/fonts && \
        cp /app/src/assets/fonts/*.ttf /usr/local/share/fonts/ && \
        fc-cache -f; \
    fi

# Ensure storage directory exists
RUN mkdir -p /app/storage/prints

EXPOSE 3001

CMD ["node", "src/server.js"]
