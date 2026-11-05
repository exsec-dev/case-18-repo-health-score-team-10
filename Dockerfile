# HealthCraft — образ сервиса. Один образ на обе роли процесса:
# роль задает PROCESS_ROLE (web | rating | all), см. deploy/compose.yaml.
# База — тот же oven/bun, что в CI (.github/workflows/ci.yml): что зелено в CI, то и едет на стенд.
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
# страницы раздела /docs и PDF документации
COPY docs/guide ./docs/guide

# /data — БД (том), /tmp/clones — временные клоны (том на диске ВМ, не в слое контейнера).
# Процесс работает от пользователя bun (uid 1000) без root: каталоги томов на хосте
# должны принадлежать этому uid (deploy/deploy.sh делает chown при создании).
RUN mkdir -p /data /tmp/clones && chown -R bun:bun /data /tmp/clones
ENV NODE_ENV=production \
    DATA_DIR=/data \
    TMPDIR=/tmp/clones

# вход: чистит осиротевшие клоны и проверяет, что тома доступны на запись
COPY deploy/entrypoint.sh /usr/local/bin/hc-entrypoint
RUN chmod 755 /usr/local/bin/hc-entrypoint
EXPOSE 8418
# живость процесса, не состояние сервиса: /api/health отвечает 200 и при "ok": false
# (подробно – в deploy/compose.yaml). PORT у ролей разный, поэтому порт берется из окружения,
# путь сервиса – из BASE_PATH (демо под /healthcraft)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8418)+(process.env.BASE_PATH||'').replace(/\/+$/,'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER bun
ENTRYPOINT ["/usr/local/bin/hc-entrypoint"]
CMD ["bun", "run", "src/server.ts"]
