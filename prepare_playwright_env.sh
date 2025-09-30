#!/bin/sh

# Install playwright and its dependencies
npx -y playwright@latest install --with-deps chromium

# install node modules
npm install
