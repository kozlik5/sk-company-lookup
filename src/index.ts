import 'dotenv/config';
import { createServer } from './server.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = createServer();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SK Company Lookup] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[SK Company Lookup] Environment: ${process.env.NODE_ENV || 'development'}`);
});
