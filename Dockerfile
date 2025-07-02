# Use a slim base image
FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy package files first and install deps
COPY package*.json ./
RUN npm install --production

# Copy app code
COPY .env .env

COPY . .

# Set env and expose port
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Start your app
CMD ["npm", "start"]
