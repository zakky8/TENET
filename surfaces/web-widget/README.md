# @tenet/surface-web-widget

Server-Sent Events streamer for embeddable browser widgets. JWT session auth, CORS allow-list, framework-agnostic `SseResponse` you wire to Express / Fastify / Hono / Cloudflare Workers.

```ts
import { WebWidgetSurface, hs256Verifier } from '@tenet/surface-web-widget';

const surface = new WebWidgetSurface({
  jwt: hs256Verifier(process.env.JWT_SECRET!),
  allowedOrigins: ['https://app.example.com'],
  stream: async function*(event, signal) {
    // your agent runtime — yield reply text chunks
    yield 'Hello, ';
    yield event.text;
  },
});

// Express
app.post('/agent', async (req, res) => {
  const r = await surface.handle({
    method: 'POST',
    headers: req.headers,
    body: req.body,
    signal: req.signal,
  });
  res.status(r.status);
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  for await (const chunk of r.body) res.write(chunk);
  res.end();
});
```
