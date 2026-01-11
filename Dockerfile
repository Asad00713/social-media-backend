# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Cache bust: 2026-01-11-v1
ARG CACHEBUST=1

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy source code
COPY . .

# Build the application and verify dist exists
RUN npm run build && ls -la dist/

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Verify dist was copied
RUN ls -la dist/

# Expose port
EXPOSE 3000

# Start the application directly (not via npm)
# NestJS builds to dist/src/main.js
CMD ["node", "dist/src/main"]
