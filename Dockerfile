# ─────────────────────────────────────────────────────────────
# Dockerfile for RCSB PDB Metabolite Explorer
# Node.js + Express server
# ─────────────────────────────────────────────────────────────

# Step 1: Use official Node.js LTS image as base
# "alpine" variant is smaller (~50MB vs ~300MB for full image)
FROM node:20-alpine

# Step 2: Set working directory inside the container
# All files will be copied here
WORKDIR /app

# Step 3: Copy package files FIRST (before source code)
# Docker caches this layer — if package.json doesn't change,
# npm install won't re-run on every build (faster builds)
COPY package.json package-lock.json* ./

# Step 4: Install only production dependencies
# --omit=dev skips nodemon and other dev tools (smaller image)
RUN npm install --omit=dev

# Step 5: Copy the rest of the project files
# .dockerignore controls what gets skipped (node_modules, .git etc)
COPY . .

# Step 6: Tell Docker which port the app listens on
# This is documentation — does not actually publish the port
# You publish it when running: docker run -p 3000:3000
EXPOSE 3000

# Step 7: Start the server
CMD ["node", "server.js"]