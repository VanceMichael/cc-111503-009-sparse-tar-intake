FROM local/111213-runtime-base:node22.22.1
WORKDIR /workspace
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=node:node . .
USER node
CMD ["npm", "test"]
