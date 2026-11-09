FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ENV NODE_ENV=production \
    KIBI_HOST=0.0.0.0 \
    KIBI_PORT=4391 \
    KIBI_DATA_DIR=/app/.data \
    KIBI_ADMIN_PASSWORD_FILE=/app/.data/admin-password
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node scripts/init.mjs ./scripts/init.mjs
COPY --chown=node:node web/ ./web/
COPY --chown=node:node sdk/ ./sdk/
COPY --chown=node:node docs/SDK.md docs/LOCAL_STUDIO.md docs/API.md docs/MODULES.md docs/VOICE.md ./docs/
COPY --chown=node:node examples/server-plugin/ ./examples/server-plugin/
COPY --chown=node:node resources/xiaozhi/ ./resources/xiaozhi/
USER node
EXPOSE 4391 9444
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:4391/api/health',{signal:AbortSignal.timeout(3000)});const b=await r.json();if(!r.ok||b.ok!==true||b.name!=='kibi-server')process.exit(1)"]
CMD ["node", "src/server.mjs"]
