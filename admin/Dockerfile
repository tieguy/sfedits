FROM node:20-slim

# Use root as base directory
WORKDIR /opt/sfedits

# Use root package.json (same as bot)
# This ensures lib/ can access all dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy shared lib first
COPY lib ./lib/

# Copy admin files
COPY admin/server.js ./admin/
COPY admin/public ./admin/public/

EXPOSE 3000

CMD ["node", "admin/server.js"]
