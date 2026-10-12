import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import react from '@vitejs/plugin-react';
import {multifront} from '@multifront/vite';
import {defineConfig, type Plugin} from 'vite';

// Dev only: `/?ssr` serves the page with the App rendered by `renderToString` in it, for the client to hydrate.
const ssrPage: Plugin = {
  name: 'react-root-props:ssr',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/?ssr') return next();
      try {
        const template = await readFile(join(server.config.root, 'index.html'), 'utf8');
        const {render} = (await server.ssrLoadModule('/src/entry-server.tsx')) as {render: () => string};
        response.setHeader('Content-Type', 'text/html');
        response.end((await server.transformIndexHtml(request.url, template)).replace('<!--ssr-->', render()));
      } catch (err) {
        next(err);
      }
    });
  },
};

export default defineConfig({plugins: [react(), multifront(), ssrPage]});
