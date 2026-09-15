import { request } from 'node:http';
import { request as secureRequest } from 'node:https';

const protocol = process.env.APP_PROTOCOL === 'https' ? 'https' : 'http';
const port = Number(process.env.PORT ?? '8443');
const requester = protocol === 'https' ? secureRequest : request;

const clientRequest = requester({
  hostname: '127.0.0.1',
  port,
  path: '/health',
  method: 'GET',
  ...(protocol === 'https' ? { rejectUnauthorized: false } : {})
}, (response) => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});

clientRequest.on('error', () => {
  process.exitCode = 1;
});
clientRequest.setTimeout(2_000, () => {
  clientRequest.destroy();
  process.exitCode = 1;
});
clientRequest.end();
