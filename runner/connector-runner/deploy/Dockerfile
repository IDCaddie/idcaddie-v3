# connector-runner — INERT deploy image SKELETON (PR #202). Represents the build-artifact shape for the future
# ECS/Fargate one-shot task. It is NOT deployable: it bakes NO secret, NO AWS credential, NO token, and its default
# command FAILS CLOSED (exits non-zero, runs nothing real). RISK-007 stays OPEN.
#
# Hard rules (enforced by scripts/check-deploy-templates.sh):
#   * NO secret/credential/token build ARGs, NO ENV secrets, NO AWS keys baked in.
#   * default CMD fails closed — it does NOT fetch a secret, call AWS/KMS, or connect to Postgres.
#   * the real run command (build the runner + invoke its entrypoint) is documented in deploy/README.md as
#     "future, not implemented" — it is NOT wired here.

FROM node:22-slim

WORKDIR /app

# Shape only: the future image copies the runner + its vendored core and builds it. Left as a comment so this skeleton
# image stays buildable without the full app context and ships nothing real.
# COPY runner/connector-runner ./runner/connector-runner
# RUN npm ci && npm run runner:typecheck

# Fail-closed default: the skeleton image runs a disabled self-check and exits non-zero. No secret, no AWS, no network.
# The production entrypoint (read the Secrets Manager secret into memory → ingest → exit) is FUTURE, NOT IMPLEMENTED
# (see deploy/README.md §"Future run command").
CMD ["node", "-e", "console.log('connector-runner: disabled (deploy skeleton — not deployable; RISK-007 OPEN)'); process.exit(1)"]
