FROM node:24-bookworm-slim

# Release is explicit. Builds fetch the official CLI package; execution never pulls an image.
ARG CODEX_VERSION=0.144.4
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force
COPY relay-wrapper.mjs /opt/companion/harness/relay-wrapper.mjs
RUN chmod 0555 /opt/companion/harness/relay-wrapper.mjs

USER 65532:65532
WORKDIR /workspace/output
ENTRYPOINT ["node", "/opt/companion/harness/relay-wrapper.mjs"]
