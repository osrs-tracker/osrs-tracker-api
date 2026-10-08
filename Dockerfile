# Stage 1: Build the application
# Both stages pin the same digest; Dependabot bumps them together when the image is rebuilt (.github/dependabot.yml)
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

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
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS production

WORKDIR /app

# webpack keeps sharp external (webpack.config.js): install the version package.json pins
COPY package.json /tmp/
RUN npm install --cpu=x64 --os=linux --libc=musl sharp@$(node -p "require('/tmp/package.json').dependencies.sharp") \
  && rm /tmp/package.json

# Copy built application from the build stage
COPY --from=build /app/dist .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV METRICS_PORT=9090

# Expose the port the app runs on
EXPOSE $PORT
EXPOSE $METRICS_PORT

# Run as the image's unprivileged user instead of root
USER node

# Command to run the application
CMD ["node", "main"]

# Health check using the /healthy endpoint of the metrics server (src/app-metrics.controller.ts)
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:9090/healthy || exit 1
