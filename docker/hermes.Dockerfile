FROM ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:85b894ae84b7c13f9c5799394fb7ef8c753c883b23a380af47eac1e7a82f6dff
USER root
COPY deploy/hermes-bridge/runtime /opt/pai
RUN chmod -R a-w /opt/pai
