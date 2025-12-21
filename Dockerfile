# Step 1: Use Node.js as the base image
FROM node:18-slim

# Step 2: Set the working directory inside the container
WORKDIR /app

# Step 3: Copy your project files into the container
COPY . /app

# Step 4: Install dependencies for the backend
WORKDIR /app/Backend
RUN npm install

# Step 5: Expose the port that the backend is listening on (change if needed)
EXPOSE 3000

# Step 6: Start the backend app when the container is run
CMD ["npm", "run", "start"]