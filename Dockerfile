# syntax=docker/dockerfile:1
# The ocra command, installed as the GitHub Action installs it
# (scripts/action-install.mjs): the published packages at this checkout's
# version, every dependency pinned by its package-lock.json, install scripts
# off, registry signatures and ocra's own provenance checked. A release image
# is built from the published packages only (OCRA_INSTALL=npm); CI builds
# the checkout itself (OCRA_INSTALL=source) to test the image.

ARG OCRA_INSTALL=npm

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS sources
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json tsconfig.package.json ./
COPY scripts ./scripts
COPY packages ./packages

# An npm install reads only the workspaces' manifests; copying just those
# keeps a source change from invalidating its cached install layer.
FROM sources AS manifests
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS install-npm
COPY --from=manifests /src /src
WORKDIR /src
ENV RUNNER_TEMP=/build GITHUB_OUTPUT=/build/output
RUN set -eu; \
    mkdir -p /build /opt/ocra; touch /build/output; \
    node scripts/action-install.mjs; \
    if grep -q '^source=' /build/output; then \
      echo "not installed from npm: $(grep '^source=' /build/output)" >&2; exit 1; \
    fi; \
    mv /build/ocra-cli /opt/ocra/app; \
    echo node_modules/@open-cr-agent/cli/dist/main.js > /opt/ocra/main

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS install-source
COPY --from=sources /src /src
WORKDIR /src
ENV RUNNER_TEMP=/build GITHUB_OUTPUT=/build/output
RUN set -eu; \
    mkdir -p /build /opt/ocra; touch /build/output; \
    node scripts/action-install.mjs --from-source; \
    mv /src /opt/ocra/app; \
    echo packages/cli/dist/main.js > /opt/ocra/main

FROM install-${OCRA_INSTALL} AS install
WORKDIR /opt/ocra
# Images up to 0.2.0 had no entrypoint and documented `docker run <image>
# ocra review`; a leading "ocra" is dropped so those command lines still work.
RUN set -eu; \
    mkdir -p /opt/ocra/bin; \
    printf '#!/bin/sh\n[ "${1-}" = ocra ] && shift\nexec node /opt/ocra/app/%s "$@"\n' "$(cat /opt/ocra/main)" > /opt/ocra/bin/ocra; \
    chmod 755 /opt/ocra/bin/ocra; \
    /opt/ocra/bin/ocra --version

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
LABEL org.opencontainers.image.source="https://github.com/jma49/Open-CR-Agent" \
      org.opencontainers.image.description="ocra, the multi-agent code reviewer" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # The checkout is owned by another user than the one ocra runs as: a
    # mount at /repo, or a GitLab job's $CI_PROJECT_DIR, cloned by the
    # runner under /builds/<namespace>/<project> or a custom builds_dir.
    # That path is not known here, and git 2.39 (bookworm) matches
    # safe.directory only exactly (a trailing /* needs 2.46), so '*' stays.
    && git config --system safe.directory '*'
COPY --from=install /opt/ocra/app /opt/ocra/app
COPY --from=install /opt/ocra/bin /opt/ocra/bin
ENV PATH=/opt/ocra/bin:$PATH
USER node
WORKDIR /repo
ENTRYPOINT ["ocra"]
CMD ["--help"]
