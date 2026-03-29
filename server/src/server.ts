import { createApp } from './app.js';
import { env } from './config.js';

const port = Number(env('PORT', '8787'));
/** Bind all interfaces so platforms like Railway/Docker can route traffic (avoids proxy 502). */
const host = env('HOST', '0.0.0.0');
const app = createApp();

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`AI Ebot server listening on http://${host}:${port}`);
});
