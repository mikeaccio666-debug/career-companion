import { createApplicationReferenceServer } from './server.ts';

const port = Number(process.env.APPLICATION_SERVICE_PORT ?? '4310');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('APPLICATION_SERVICE_PORT_INVALID');
}

const server = await createApplicationReferenceServer();
server.listen(port, '127.0.0.1', () => {
  console.info(`Application reference service: http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close());
}
