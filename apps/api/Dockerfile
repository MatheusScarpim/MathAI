FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/

RUN npm install -g npm@10.9.0
RUN npm install --workspaces

# Oracle Instant Client for node-oracledb thick mode (required for NJS-533 / ORA-12660 cases)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip libaio1 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/oracle \
  && curl -L -o /tmp/instantclient-basiclite.zip https://download.oracle.com/otn_software/linux/instantclient/2390000/instantclient-basiclite-linux.x64-23.9.0.25.07.zip \
  && unzip -q /tmp/instantclient-basiclite.zip -d /opt/oracle \
  && rm -f /tmp/instantclient-basiclite.zip \
  && ln -s /opt/oracle/instantclient_* /opt/oracle/instantclient

ENV ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient:${LD_LIBRARY_PATH}

COPY apps/api apps/api
COPY packages/shared packages/shared

RUN npm --workspace packages/shared run build
RUN npm --workspace apps/api run build

WORKDIR /app/apps/api

EXPOSE 3001

CMD ["node", "dist/index.js"]
