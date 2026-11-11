import {defineConfig} from 'vite';
import {apiMiddleware} from './server/api.ts';

export default defineConfig(({mode}) => {
  // pnpm demo: a separate data folder with sample Work and Personal workspaces, so your real data is untouched.
  if (mode === 'demo') { process.env.TASKS_DB ??= 'demo-data/tasks.db'; process.env.TASKS_BACKUPS ??= 'demo-data/backups'; process.env.TASKS_DEMO = '1'; }
  return {
    // cors off: other sites and other localhost ports must not read or write the API.
    server: {host: '127.0.0.1', port: 5190, strictPort: true, cors: false},
    plugins: [{
      name: 'tasks-api',
      configureServer(server) {
        server.middlewares.use(apiMiddleware());
        // The API runs inside this process; restart it when server code changes so edits take effect.
        server.watcher.add('server');
        server.watcher.on('all', (_event, file) => { if (/[\\/]server[\\/].+\.ts$/.test(file)) server.restart(); });
      },
    }],
  };
});
