# HealthCraft — образ сервиса (В5.4). Один образ на обе роли процесса:
# роль задает PROCESS_ROLE (web | rating | all), см. deploy/compose.yaml.
# База — тот же oven/bun, что в CI (.sourcecraft/ci.yaml): что зелено в CI, то и едет на стенд.
FROM oven/bun:1.4.2

# git — клоны репозиториев (src/collectors/git.ts); setsid (util-linux) уже в базе
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# зависимости отдельным слоем: пересобираются только при смене lock-файла
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY prompts ./prompts
COPY src ./src

# /data — БД (том), /tmp/clones — временные клоны (том на диске ВМ, не в слое контейнера)
RUN mkdir -p /data /tmp/clones && chown -R bun:bun /data /tmp/clones
ENV NODE_ENV=production \
    DATA_DIR=/data \
    TMPDIR=/tmp/clones

# вход: отдает каталоги томов пользователю bun и запускает процесс от него (не от root)
COPY deploy/entrypoint.sh /usr/local/bin/hc-entrypoint
RUN chmod 755 /usr/local/bin/hc-entrypoint
EXPOSE 8418
ENTRYPOINT ["/usr/local/bin/hc-entrypoint"]
CMD ["bun", "run", "src/server.ts"]
