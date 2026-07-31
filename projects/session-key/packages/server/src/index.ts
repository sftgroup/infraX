import { start } from './app.js';

start().catch((err) => {
  console.error('Failed to start Session Key Engine:', err);
  process.exit(1);
});
