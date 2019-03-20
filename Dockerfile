FROM node:8.14.0-alpine as basis

RUN apk add git python make bash gcc g++ zlib-dev --no-cache

# Create app directory
WORKDIR /opt/dojot-media-server

# Install app dependencies
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .
#RUN npm install

# Start app
CMD [ "npm", "start" ]
