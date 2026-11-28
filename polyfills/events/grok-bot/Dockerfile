FROM node:22-alpine

WORKDIR /app
COPY plugin/dist/bridge.mjs /app/bridge.mjs

ENV GROK_EVENTS_HOME=/data \
    GROK_EVENTS_READER_HOST=0.0.0.0 \
    GROK_EVENTS_READER_PORT=8787

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${GROK_EVENTS_READER_PORT}/health >/dev/null || exit 1

CMD ["node", "/app/bridge.mjs", "start"]
