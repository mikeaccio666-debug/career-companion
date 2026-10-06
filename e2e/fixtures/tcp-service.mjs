import { createServer } from 'node:net';

const port = Number(process.env.T22_TEST_SERVICE_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('T22_TEST_SERVICE_PORT_INVALID');
}

const server = createServer();
server.listen(port, '127.0.0.1');

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
