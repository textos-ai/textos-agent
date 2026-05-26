import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  XAI_SCRIPTS_KV: KVNamespace;
  XAI_PUBLISH_TOKEN: string;
};

const xaiFyi = new Hono<{ Bindings: Env }>();

xaiFyi.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

xaiFyi.get('/scripts', async (c) => {
  const indexRaw = await c.env.XAI_SCRIPTS_KV.get('xai:index');
  const dates: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  const items: Array<{ date: string; generated_at: string; preview: string }> = [];
  for (const date of dates) {
    const raw = await c.env.XAI_SCRIPTS_KV.get(`xai:script:${date}`);
    if (!raw) continue;
    const data = JSON.parse(raw);
    items.push({
      date,
      generated_at: data.generated_at,
      preview: (data.scripts?.s30 || '').slice(0, 240),
    });
  }
  return c.json({ items });
});

xaiFyi.get('/scripts/:date', async (c) => {
  const date = c.req.param('date');
  const raw = await c.env.XAI_SCRIPTS_KV.get(`xai:script:${date}`);
  if (!raw) return c.json({ error: 'not_found' }, 404);
  return c.json(JSON.parse(raw));
});

xaiFyi.post('/scripts', async (c) => {
  const auth = c.req.header('Authorization') || '';
  if (auth !== `Bearer ${c.env.XAI_PUBLISH_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{
    date: string;
    scripts: Record<string, string>;
    generated_at?: string;
  }>();
  if (!body.date || !body.scripts) {
    return c.json({ error: 'missing_fields' }, 400);
  }
  await c.env.XAI_SCRIPTS_KV.put(
    `xai:script:${body.date}`,
    JSON.stringify({
      generated_at: body.generated_at || new Date().toISOString(),
      scripts: body.scripts,
    })
  );
  const indexRaw = await c.env.XAI_SCRIPTS_KV.get('xai:index');
  const dates: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!dates.includes(body.date)) {
    dates.push(body.date);
    dates.sort().reverse();
    await c.env.XAI_SCRIPTS_KV.put('xai:index', JSON.stringify(dates));
  }
  return c.json({ ok: true, date: body.date });
});

export default xaiFyi;