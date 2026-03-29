import { createApp } from './app.js';
import { env } from './config.js';

const port = Number(env('PORT', '8787'));
const app = createApp();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`AI Ebot server listening on :${port}`);
});
