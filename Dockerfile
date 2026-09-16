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

# The migration runner reads the raw .sql files at runtime, so they must exist
# in the production image, not only in the builder stage.
COPY --from=builder /app/drizzle ./drizzle

# Verify dist was copied
RUN ls -la dist/

# Expose port
EXPOSE 3000

# Migrations run BEFORE the app starts, in the same container, every deploy.
#
# This ordering is the point: on 2026-09-10 the billing code shipped while
# migrations 0030-0034 sat unapplied, and because WorkspaceSuspendedGuard is a
# global guard querying subscriptions.user_id, one missing column 500'd every
# authenticated request in production.
#
# `&&` means a failed migration stops the boot. That is deliberate: a container
# that will not start is a loud, recoverable failure, while a container serving
# traffic against a schema it does not match is a silent outage.
CMD ["sh", "-c", "node dist/src/drizzle/migrate/migrate && node dist/src/main"]
