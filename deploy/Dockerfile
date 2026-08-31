# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /opt/nuvrion
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts

ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NUVRION_RUNTIME_PROFILE=production NUVRION_HOST=0.0.0.0 NUVRION_PORT=4100
WORKDIR /opt/nuvrion
COPY --from=dependencies --chown=node:node /opt/nuvrion/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node apps ./apps
COPY --chown=node:node modules ./modules
COPY --chown=node:node providers ./providers
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node database ./database
COPY --chown=node:node tools ./tools
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 CMD ["node","-e","fetch('http://127.0.0.1:4100/api/v1/readiness').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node","apps/api/src/server.js"]
