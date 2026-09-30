# syntax=docker/dockerfile:1
# The ocra command, installed as the GitHub Action installs it
# (scripts/action-install.mjs): the published packages at this checkout's
# version, every dependency pinned by its package-lock.json, install scripts
# off, registry signatures and ocra's own provenance checked. A release image
# is built from the published packages only (OCRA_INSTALL=npm); CI builds
# the checkout itself (OCRA_INSTALL=source) to test the image.

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS install
ARG OCRA_INSTALL=npm
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
ENV RUNNER_TEMP=/build GITHUB_OUTPUT=/build/output
RUN set -eu; \
    mkdir -p /build /opt/ocra/bin; touch /build/output; \
    if [ "$OCRA_INSTALL" = source ]; then \
      node scripts/action-install.mjs --from-source; \
      mv /src /opt/ocra/app; \
      main=packages/cli/dist/main.js; \
    else \
      node scripts/action-install.mjs; \
      if grep -q '^source=' /build/output; then \
        echo "not installed from npm: $(grep '^source=' /build/output)" >&2; exit 1; \
      fi; \
      mv /build/ocra-cli /opt/ocra/app; \
      main=node_modules/@open-cr-agent/cli/dist/main.js; \
    fi; \
    printf '#!/bin/sh\nexec node /opt/ocra/app/%s "$@"\n' "$main" > /opt/ocra/bin/ocra; \
    chmod 755 /opt/ocra/bin/ocra; \
    /opt/ocra/bin/ocra --version

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
LABEL org.opencontainers.image.source="https://github.com/jma49/Open-CR-Agent" \
      org.opencontainers.image.description="ocra, the multi-agent code reviewer" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # CI mounts the checkout owned by another user than the one ocra runs as.
    && git config --system safe.directory '*'
COPY --from=install /opt/ocra /opt/ocra
ENV PATH=/opt/ocra/bin:$PATH
USER node
WORKDIR /repo
CMD ["ocra", "--help"]
