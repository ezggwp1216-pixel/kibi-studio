# Official Docker CLI, immutable multi-platform index checked on 2026-11-17.
FROM docker:28.3.3-cli@sha256:0135662b510037ea581d99c2e5929c5e01185139c0b86986a418bd4da0b98a44 AS tools

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG KIBI_UID=1000
ARG KIBI_GID=1000
WORKDIR /broker
COPY --from=tools /usr/local/bin/docker /usr/local/bin/docker
COPY src/plugins/ ./src/plugins/
RUN mkdir -p /run/kibi-executor \
 && chown "${KIBI_UID}:${KIBI_GID}" /run/kibi-executor \
 && chmod 0700 /run/kibi-executor
USER ${KIBI_UID}:${KIBI_GID}
ENV KIBI_PLUGIN_BROKER_SOCKET=/run/kibi-executor/worker.sock
CMD ["node", "src/plugins/broker-main.mjs"]
