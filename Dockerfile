FROM node:22.22.1-bookworm-slim
WORKDIR /workspace
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=node:node . .
USER node
CMD ["npm", "test"]
