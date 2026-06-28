// GET /api/health — reports which rate-limiter backend is active so you can
// confirm the durable (Redis) limiter is wired up, not silently falling back to
// in-memory. Never returns secrets or connection details.
import { createClient } from "redis";

export default async function handler(req, res) {
  const url = process.env.REDIS_URL || process.env.KV_URL || "";
  if (!url) {
    return res.status(200).json({ ok: true, rateLimiter: "in-memory", redis: false });
  }
  let client;
  try {
    client = createClient({ url });
    client.on("error", () => {});
    await client.connect();
    const pong = await client.ping();
    return res.status(200).json({ ok: true, rateLimiter: "durable", redis: pong === "PONG" });
  } catch {
    // Configured but unreachable — limiter degrades to in-memory at runtime.
    return res.status(200).json({ ok: true, rateLimiter: "in-memory", redis: false, redisConfiguredButUnreachable: true });
  } finally {
    try { await client?.quit(); } catch { /* ignore */ }
  }
}
