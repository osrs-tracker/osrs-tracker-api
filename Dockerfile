# Stage 1: Build the application
FROM node:22-alpine AS build

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install the application dependencies
RUN npm ci

# Copy the rest of the application files
COPY . .

# Build the NestJS application
RUN npm run build

# Stage 2: Setup production environment
FROM node:22-alpine AS production

WORKDIR /app

# Copy built application from the build stage
COPY --from=build /app/dist ./dist

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV METRICS_PORT=9090

# Expose the port the app runs on
EXPOSE $PORT
EXPOSE $METRICS_PORT

# Command to run the application
CMD ["node", "dist/main"]

# Health check using the /healthy endpoint available in server.ts
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:9090/healthy || exit 1
