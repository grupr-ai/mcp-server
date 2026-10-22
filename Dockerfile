# Grupr MCP server, hosted connector (Streamable HTTP at /mcp).
# Build:  docker build -t grupr-mcp .
# Run:    docker run -p 8787:8787 -e GRUPR_BASE_URL=... -e MCP_PUBLIC_URL=... grupr-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/mcp/health > /dev/null || exit 1
CMD ["node", "dist/http.js"]
