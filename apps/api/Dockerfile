FROM node:20-bookworm-slim

WORKDIR /app

# System deps (git required by npm pra alguns sub-deps; curl/unzip pro Oracle e cloudflared;
# ffmpeg pra converter webm->mp4 no preview screenshot — o bundle do Playwright e minimo).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git unzip libaio1 ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Oracle Instant Client for node-oracledb thick mode (required for NJS-533 / ORA-12660 cases)
RUN mkdir -p /opt/oracle \
  && curl -L -o /tmp/instantclient-basiclite.zip https://download.oracle.com/otn_software/linux/instantclient/2390000/instantclient-basiclite-linux.x64-23.9.0.25.07.zip \
  && unzip -q /tmp/instantclient-basiclite.zip -d /opt/oracle \
  && rm -f /tmp/instantclient-basiclite.zip \
  && ln -s /opt/oracle/instantclient_* /opt/oracle/instantclient

ENV ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient

# Cloudflared (preview tunnels)
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
      -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared

COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/

RUN npm install -g npm@10.9.0 serve@14
RUN npm install --workspaces

# Playwright (preview screenshots no comando !test)
# --with-deps instala chromium + libs do sistema (libnss3, libatk, fontes, etc).
# Cache em /ms-playwright pra reuso entre rebuilds.
# IMPORTANTE: invocar via workspace (apps/api) pra usar a versao EXATA resolvida
# pelo npm install — npx --yes playwright@x.y.z baixa uma copia ephemeral que
# pode usar revisao de chromium diferente da resolvida (causa "Executable doesnt exist").
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd apps/api && npx playwright install --with-deps chromium

COPY apps/api apps/api
COPY packages/shared packages/shared

RUN npm --workspace packages/shared run build
RUN npm --workspace apps/api run build

WORKDIR /app/apps/api

EXPOSE 3001

CMD ["node", "dist/index.js"]
