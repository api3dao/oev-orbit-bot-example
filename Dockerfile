# =============================================================================================
# Base image
# =============================================================================================
FROM node:20-slim AS base
WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Fetch all packages into a virtual store (specifically intended for Docker images)
# See: https://pnpm.io/cli/fetch
COPY pnpm-lock.yaml /app
RUN pnpm fetch

# Install and build dependencies
COPY . /app
RUN pnpm install --prefer-offline --recursive
RUN pnpm run build

# =============================================================================================
# OEV Bot image
# =============================================================================================
# Prepare the app image
FROM base AS oev-bot
ENV name="oev-bot"
LABEL application="oev-bot" description="OEV Bot container"
WORKDIR /app

# "node" Docker images come with a built-in, least-privileged user called "node"
USER node
COPY --chown=node:node --from=base /app/ .

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/src/index.js"]
