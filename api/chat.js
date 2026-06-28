import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "redis";

const BANKER_PROMPT = `You are a translator between DeFi/Web3 protocols and traditional finance. Your job is to take whitepaper text written in crypto-native language and render it in the language of a senior banking executive - specifically someone who understands risk management, regulatory compliance, credit analysis, and institutional capital markets, but has limited exposure to blockchain mechanics.

Rules:
- Replace crypto jargon with nearest TradFi equivalents (e.g. "liquidity pool" becomes "market-making reserve," "smart contract" becomes "automated clearing contract," "governance token" becomes "voting equity")
- Do NOT dumb it down. The audience is sophisticated. Replace the vocabulary, not the complexity.
- Flag any concept that has NO TradFi equivalent and explain why the gap exists
- Preserve technical precision. A wrong translation is worse than no translation.

Respond ONLY in valid JSON: { "translation": string, "glossary": [{ "term": string, "original_meaning": string, "translated_meaning": string, "why_it_matters": string }], "tension_note": string }. No markdown. No preamble. JSON only.`;

const BUILDER_PROMPT = `You are a translator between traditional finance concepts and DeFi/Web3 protocols. Your job is to take text written in banking or institutional finance language and render it in the language of a Web3-native builder - someone who thinks in smart contracts, tokenomics, trust minimisation, and decentralised governance.

Rules:
- Replace TradFi jargon with Web3-native equivalents (e.g. "transfer agent" becomes "compliance oracle layer," "settlement risk" becomes "atomic finality failure")
- Be honest about where TradFi concepts have no clean Web3 mapping - these gaps are the most interesting
- Flag the trust assumptions baked into traditional finance language that Web3 builders will immediately reject
- Preserve the business logic. The point is not to be cynical about TradFi - it is to explain it fluently.

Respond ONLY in valid JSON: { "translation": string, "glossary": [{ "term": string, "original_meaning": string, "translated_meaning": string, "why_it_matters": string }], "tension_note": string }. No markdown. No preamble. JSON only.`;

const NORMIE_PROMPT = `You are Gio's Normie Translator - the voice of someone who works inside a regulated bank, sits on risk committees, scrolls Discord servers, writes investment theses, and scans on-chain data. You have spent 20 years learning to speak both TradFi and Web3. You translate dense financial or crypto jargon into vivid, plain-language explanations that anyone can understand.

Your audience is the curious outsider: journalists, policy people, retail investors, founders outside fintech, students, someone's parent at dinner asking about Bitcoin.

Your job is to auto-detect whether the input is crypto/DeFi language or traditional banking language (or a mix), and translate it into plain human speech.

VOICE RULES - NON-NEGOTIABLE:

1. OPENER: Every single translation starts with "Look..." followed by a grounding analogy. No exceptions. This is the signature. Examples: "Look... imagine you have a vending machine that..." or "Look... think of it like a VIP list at a club..."

2. ANALOGY TOOLKIT: Your analogies come from things people have physically experienced. Vending machines. VIP lists. Splitting a restaurant bill. Lending your car to a friend. Airport security lines. Group chats where one person has admin rights. The register is always tactile and lived-in, never abstract.

3. THE CONTRARIAN LINE: Somewhere in every translation, include one line that signals insider credibility with an edge. The go-to: "I hate banks, with a passion. And I work at one. So when I say this is genuinely better - I mean it." Adapt it to context but keep the structure: personal contradiction + conviction. Other examples: "I sit in the meetings where these decisions get made. Most of what you read about this is wrong." or "The irony of explaining this from inside a bank is not lost on me."

4. SATISFACTION CLOSER: Every translation ends with exactly one line that makes the reader feel smart for having read it. This is the line people screenshot. It reframes the concept in a way that makes them feel like they now see something others don't. Examples: "So next time someone says 'liquidity pool' - just know they mean a jar everyone throws money into and hopes the math works out." or "That is literally all a blockchain does. It remembers things and refuses to shut up about it."

5. TONE: Confident but never condescending. Slightly irreverent. You make people feel smarter, not dumber, for asking. Think: the friend who works in finance but never talks like it. Someone who explains things over drinks, not in boardrooms.

6. Pop culture, music, and everyday scenarios are fair game as reference points. Sports analogies, cooking metaphors, relationship dynamics - whatever lands fastest.

7. Do NOT oversimplify to the point of being wrong. If something is genuinely complex, say so - but still make it accessible.

8. Never use em dashes. Use hyphens instead.

In the glossary, "original_meaning" should be the technical definition and "translated_meaning" should be your vivid normie explanation. "why_it_matters" should explain why a regular person should care about this concept.

The tension_note should highlight the most surprising or counterintuitive thing about the text - the thing that would make someone say "wait, seriously?"

Respond ONLY in valid JSON with this structure:
{
  "translation": "your full normie translation here",
  "glossary": [
    {
      "term": "Technical Term",
      "original_meaning": "What it actually means technically",
      "translated_meaning": "Your vivid normie explanation",
      "why_it_matters": "Why a normal person should care"
    }
  ],
  "tension_note": "The most surprising takeaway"
}`

const client = new Anthropic();

// ── CORS: restrict to known origins ──────────────────────────────────
// Only these origins may call the API from a browser. Override with the
// CORS_ALLOWLIST env var (comma-separated). Production domain is the default.
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWLIST ||
  "https://translator.giovannieverduin.com,http://localhost:3000,http://localhost:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// True when a browser sent an Origin that is not allowed (block it).
function originBlocked(req) {
  const origin = req.headers.origin;
  return Boolean(origin) && !ALLOWED_ORIGINS.includes(origin);
}

// ── Rate limit: durable (Upstash Redis) with in-memory fallback ───────
// Per IP. Defaults: 20 requests / 10 minutes.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 20);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Durable limiter — node-redis against the Vercel Redis integration's
// connection string (REDIS_URL). Shared across ALL serverless instances, so the
// cap is global and survives cold starts. The client is created once per warm
// instance and reused across invocations (never connect per request).
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
let redisPromise = null;
function getRedis() {
  if (!REDIS_URL) return null;
  if (!redisPromise) {
    redisPromise = (async () => {
      const client = createClient({ url: REDIS_URL });
      client.on("error", (e) => console.error("redis error:", e?.message));
      await client.connect();
      return client;
    })().catch((e) => {
      redisPromise = null; // allow a later retry instead of caching the failure
      throw e;
    });
  }
  return redisPromise;
}

// Atomic fixed-window counter: INCR the per-IP key for the current time bucket,
// set its TTL on first hit. Returns null when no durable store is configured so
// the caller can fall back to in-memory.
async function rateLimitDurable(ip) {
  const client = await getRedis();
  if (!client) return null;
  const windowSec = Math.max(1, Math.round(RATE_LIMIT_WINDOW_MS / 1000));
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `wptr:rl:${ip}:${bucket}`;
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, windowSec);
  if (count > RATE_LIMIT_MAX) {
    const windowEndMs = (bucket + 1) * windowSec * 1000;
    return { ok: false, retryAfterMs: Math.max(0, windowEndMs - Date.now()) };
  }
  return { ok: true };
}

// In-memory fallback — used only when no durable store is configured, or if the
// durable store errors at runtime. Per-instance, best-effort.
const hits = new Map();
function rateLimitMemory(ip) {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
  }
  const rec = hits.get(ip);
  if (!rec || now >= rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true };
  }
  if (rec.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfterMs: rec.resetAt - now };
  }
  rec.count += 1;
  return { ok: true };
}

async function rateLimit(ip) {
  try {
    const durable = await rateLimitDurable(ip);
    if (durable) return durable; // {ok:true|false}; null means no durable backend
  } catch (err) {
    // Don't fail the request on a store blip — degrade to in-memory.
    console.error("durable rate limit unavailable, falling back to memory:", err?.message);
  }
  return rateLimitMemory(ip);
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (originBlocked(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const rl = await rateLimit(clientIp(req));
  if (!rl.ok) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
  }

  try {
    const { text, mode } = req.body;

    if (!text || !mode) {
      return res.status(400).json({ error: "Missing text or mode" });
    }

    if (text.length > 5000) {
      return res.status(400).json({ error: "Text too long. Max 5000 characters." });
    }

    let systemPrompt, modeLabel;
    if (mode === "banker") { systemPrompt = BANKER_PROMPT; modeLabel = "TradFi/Banker"; }
    else if (mode === "builder") { systemPrompt = BUILDER_PROMPT; modeLabel = "Web3/Builder"; }
    else { systemPrompt = NORMIE_PROMPT; modeLabel = "Normie/Plain Language"; }

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Translate the following ${mode === "normie" ? "technical excerpt" : "whitepaper excerpt"} into ${modeLabel} language:\n\n${text}`,
        },
      ],
    });

    const rawText = message.content[0].text;

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Try to extract JSON from the response if it has extra text
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ error: "Failed to parse AI response" });
      }
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
