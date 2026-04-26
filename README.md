# dashboard-boilerplate

This repo is a dashboard boilerplate demonstrating a Cloudflare Pages Functions backend paired with a lightweight React UI that runs without a build step.

## Demo: Runtime random API

A small Cloudflare Pages Function at `functions/random.ts` returns a runtime JSON payload with a random value. The dashboard demonstrates both:

- A **build-time** random value generated in the client at startup (static for the session).
- A **runtime** random value fetched from the server (`/api/random`) on each page load or on demand.

## Local development

```bash
npm run dev
```

This starts a tiny Node server (`dev-server.js`) that serves the static frontend and a local `/api/random` endpoint so you can test the runtime tile without Cloudflare Pages.

## Production deployment (Cloudflare Pages)

Cloudflare Pages will serve the frontend files and the `functions/` directory. When deployed, `/api/random` is handled by the Pages Function in `functions/random.ts`.

Styling: added orange/green brand tints, dark-mode support and a compact/dense UI toggle for an industrial, information-dense look.
