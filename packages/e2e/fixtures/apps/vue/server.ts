// Dev SSR in Vite middleware mode: `GET /` renders App.vue on the server, `entry-client.ts` hydrates it.
// Run with `node --conditions=source server.ts`, so the app's config loads `@multifront/vite` from `src/`.
import {createServer as createHttpServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createServer} from 'vite';
import type {render as renderApp} from './src/entry-server.ts';

// `index.html` stays the client-only page: a hydrating entry there would warn on its empty container.
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>vue ssr</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="app"><!--app-html--></div>
    <script type="module" src="/src/entry-client.ts"></script>
  </body>
</html>
`;

const httpServer = createHttpServer();
const vite = await createServer({
  root: import.meta.dirname,
  configLoader: 'native',
  appType: 'custom',
  // The HMR websocket shares our port: parallel servers never fight over Vite's default one.
  server: {middlewareMode: true, hmr: {server: httpServer}},
});

httpServer.on('request', (request, response) => {
  vite.middlewares(request, response, async () => {
    if (request.url !== '/') {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      const template = await vite.transformIndexHtml(request.url, TEMPLATE);
      const {render} = (await vite.ssrLoadModule('/src/entry-server.ts')) as {render: typeof renderApp};
      response.setHeader('Content-Type', 'text/html');
      response.end(template.replace('<!--app-html-->', await render()));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      vite.ssrFixStacktrace(error);
      response.statusCode = 500;
      response.end(error.stack);
    }
  });
});

httpServer.listen(0, 'localhost', () => {
  const {port} = httpServer.address() as AddressInfo;
  process.stdout.write(`ssr server: http://localhost:${port}/\n`);
});
