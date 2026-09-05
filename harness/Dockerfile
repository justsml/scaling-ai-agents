FROM oven/bun:1.3.1-alpine@sha256:514fe15804f8ad3772ba323c2298daf121bb4b42386e2522998de5e87f16a94c

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 8080
CMD ["bun", "run", "src/gateway/server.ts"]
