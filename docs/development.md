# Developer setup

1. Copy `.env.example` to `.env` when external services are enabled.
2. Run `npm run check`, `npm test`, and `npm run migrate:check`.
3. Run `npm run dev` and open `http://127.0.0.1:4100`.
4. Sign in with the local administrator, add a connection with the development mock adapter, run discovery, and operate the discovered virtual machines from the console.

The default runnable profile uses an in-memory broker/task store. `deploy/compose.yaml` defines PostgreSQL and RabbitMQ for the next adapter step. Never use the example passwords outside local development.
