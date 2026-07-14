import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import OpenAI from "openai";


import SYSTEM_PROMPT from "../prompt.js";
import RESPONSE_SCHEMA from "../schema.js";

dotenv.config();

const app = express();

// --- Lock-down config ------------------------------------------------
// ALLOWED_ORIGINS: comma-separated list, e.g.
//   "https://discoveratlanticcanada.com,https://www.discoveratlanticcanada.com"
// WIDGET_SHARED_SECRET: any long random string, shared between this
// deployment and the WordPress embed. It is NOT a substitute for real
// auth (it ships in page source, so a determined person can read it) -
// its job is to stop opportunistic bots and other sites from hot-linking
// this endpoint and burning your OpenRouter quota, not to stop a
// motivated attacker.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const WIDGET_SHARED_SECRET = process.env.WIDGET_SHARED_SECRET || "";

// The client sends the photo as a base64 data-URL STRING field (not a
// multipart file part), so multer/busboy treats it as a text field.
// The relevant cap is therefore `fieldSize`, not `fileSize` - and busboy's
// default fieldSize is only 1MB, which silently breaks any upload once the
// base64-encoded photo (raw size * ~1.33) crosses that line. Size this to
// comfortably fit a 6MB photo after base64 inflation (~8MB) plus the
// "data:image/...;base64," prefix.
const upload = multer({
    limits: {
        fileSize: 6 * 1024 * 1024,
        fieldSize: 9 * 1024 * 1024
    }
});

app.use(cors({
    origin: function (origin, callback) {
        // Same-origin tools (curl, server-to-server, Vercel's own preview
        // pings) send no Origin header at all - allow those through so
        // health checks don't break, but browsers always send Origin for
        // cross-site fetch(), so this does not weaken the browser-facing
        // lock-down.
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Origin not allowed"));
    }
}));

// --- Shared-secret + basic rate limit ---------------------------------
// Best-effort, in-memory: resets on cold start and isn't shared across
// concurrent Vercel instances. Fine as a first line of defense against
// casual abuse; if this endpoint ever gets real traffic, swap this Map
// for Upstash Redis (a few lines, works natively with Vercel).
const rateLimitHits = new Map();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitHits.get(ip);
    if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
        rateLimitHits.set(ip, { start: now, count: 1 });
        return false;
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT_MAX;
}

app.use("/api/chat", (req, res, next) => {
    if (WIDGET_SHARED_SECRET && req.headers["x-widget-secret"] !== WIDGET_SHARED_SECRET) {
        return res.status(401).json({ success: false, message: "Unauthorized." });
    }
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    if (isRateLimited(ip)) {
        return res.status(429).json({ success: false, message: "Too many requests - please wait a few minutes and try again." });
    }
    next();
});

app.use(express.json({
    limit: "15mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "15mb"
}));



const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    // The SDK's default timeout is 10 minutes, and with retries that can
    // mean ~30 minutes before a hung/overloaded free-tier model ever
    // surfaces an error to the client. 30s keeps the UI responsive.
    timeout: 30 * 1000,
defaultHeaders: {
    "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
    "X-Title": "Atlantic AI Planner Demo"
}
});

const MODEL = "mistralai/mistral-small-3.2-24b-instruct";



app.post("/api/chat", upload.none(), async (req, res) => {

    try {

        const { message, image, history } = req.body;

        if (!message && !image) {
            return res.status(400).json({
                success: false,
                message: "Message or image required."
            });
        }

        const messages = [];

        messages.push({
            role: "system",
            content:
                SYSTEM_PROMPT +
                "\n\nIMPORTANT:\nReturn ONLY valid JSON.\nDo not wrap the response in markdown.\nDo not include ```json fences."
        });

        if (history) {
            try {
                const parsed = JSON.parse(history);

                if (Array.isArray(parsed)) {
                    parsed.forEach(m => {
                        if (!m.role || !m.content) return;

                        messages.push({
                            role: m.role,
                            content: m.content
                        });
                    });
                }
            } catch {}
        }

        if (image) {

            messages.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: message || "Plan a trip inspired by this image."
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: image
                        }
                    }
                ]
            });

        } else {

            messages.push({
                role: "user",
                content: message
            });

        }

        const completion = await client.chat.completions.create({
            model: MODEL,
            messages,
            temperature: 0.7,
            response_format: RESPONSE_SCHEMA
        });

        const content = completion.choices[0].message.content.trim();

        let itinerary;

        try {

            itinerary = JSON.parse(
                content
                    .replace(/^```json/i, "")
                    .replace(/^```/, "")
                    .replace(/```$/, "")
                    .trim()
            );

        } catch (err) {

            console.error("Raw model response:");
            console.error(content);

            return res.status(500).json({
                success: false,
                message: "Model returned invalid JSON.",
                raw: content
            });

        }

        return res.json({
            success: true,
            itinerary,
            assistant_raw: JSON.stringify(itinerary)
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }

});

// Without this, an error thrown by middleware upstream of a route handler
// (e.g. multer rejecting an oversized field) falls through to Express's
// default HTML error page. The client always calls res.json() on the
// response, so an HTML body there throws a parse error client-side and
// surfaces as a generic "couldn't reach the planner" message, masking the
// real cause. Keeping this JSON means every failure mode is one the
// frontend can actually read and show to the user.
app.use((err, req, res, next) => {

    if (res.headersSent) {
        return next(err);
    }

    console.error(err);

    const status = err.status || err.statusCode || 500;

    res.status(status).json({
        success: false,
        message: err.code === "LIMIT_FIELD_VALUE"
            ? "That photo's a little large for the request - try a smaller one."
            : (err.message || "Unexpected server error.")
    });

});

export default app;