"use strict";

/** Backend base URL. Override with ISTV_BACKEND_URL; defaults to the hosted production backend. */
const BACKEND_URL = (process.env.ISTV_BACKEND_URL || "https://istv-reel-editor-backend-2b8q.onrender.com").replace(/\/$/, "");

module.exports = { BACKEND_URL };
