FROM node:lts-alpine

RUN apk add --no-cache tini

ENV NODE_ENV=production

WORKDIR /app

# 先装依赖，利用层缓存：只有 package.json 变化才重新安装。
# 仓库未跟踪 lockfile（pnpm-lock.yaml 在 .gitignore 里），因此不能用 ci/frozen-lockfile。
COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷代码（.dockerignore 已排除本地 node_modules，不会覆盖上面的安装结果）
COPY --chown=node:node . ./

USER node

EXPOSE 3000

# 运行时通过 --env-file / -e 注入配置，不要把 .env 打进镜像
CMD [ "/sbin/tini", "--", "node", "app.js" ]
