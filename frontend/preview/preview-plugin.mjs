import { createPreviewApi } from './preview-api.mjs';

export function previewPlugin() {
  const api = createPreviewApi();
  function installMiddleware(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/api/v1/')) {
        next();
        return;
      }
      void api.handle(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
        }
        response.end(JSON.stringify({ data: null, error: { code: 'PREVIEW_ERROR', message: 'The mock preview request failed.' } }));
      });
    });
  }
  return {
    name: 'personal-ai-workspace-preview-api',
    configurePreviewServer: installMiddleware
  };
}
