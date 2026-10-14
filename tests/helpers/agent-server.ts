import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal Node HTTP server that serves the SAME agent handlers as the Next.js
 * routes (/api/extension/agent, /upload, /media/:id) against the test DB.
 */
export async function startAgentServer(): Promise<{ origin: string; close: () => Promise<void>; requests: { action: string }[] }> {
  const { handleAgentRequest } = await import('@/lib/agent/handler');
  const { handleUpload, handleMediaDownload } = await import('@/lib/agent/files');
  const requests: { action: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : body });
    try {
      if (req.method === 'POST' && req.url?.startsWith('/api/extension/agent')) {
        try {
          requests.push({ action: JSON.parse(body.toString('utf8')).action });
        } catch {
          /* ignore */
        }
      }
      let response: Response;
      if (req.url?.startsWith('/api/extension/upload')) response = await handleUpload(request);
      else if (req.url?.startsWith('/api/extension/media/')) {
        const id = req.url.split('/api/extension/media/')[1].split('?')[0];
        response = req.method === 'OPTIONS' ? await handleAgentRequest(request) : await handleMediaDownload(request, id);
      } else response = await handleAgentRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
