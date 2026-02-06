FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/

RUN npm install -g npm@10.9.0
RUN npm install --workspaces

COPY apps/api apps/api
COPY packages/shared packages/shared

RUN npm --workspace packages/shared run build
RUN npm --workspace apps/api run build

WORKDIR /app/apps/api

EXPOSE 3001

CMD ["node", "dist/index.js"]
