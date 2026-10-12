// Supabase Edge Function: get-golf-course
// Deploy this as a Supabase Edge Function named `get-golf-course`.
// It expects a JSON body containing:
//   { "courseId": "pmyjyz8s" }
//
// It uses the secret:
//   GOLF_COURSE_API_KEY
//
// It also uses the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

// --- API usage tracking -------------------------------------------------
// This app-wide counter is kept purely for observability (so we can see
// how many calls we're making against the Golf Course API day to day).
// It is NOT used to pre-emptively block requests — we don't try to
// predict when we'll run out. Instead, the Golf Course API itself is the
// source of truth: if we've hit our limit, it tells us with a 429, and
// we handle that gracefully below. If a course can't be retrieved, the
// user just falls back to entering it manually.
// Kept inline (rather than imported from a shared module) so this
// function can be deployed as a single file with no bundling of relative
// imports. If you ever need to change this, update it here AND in
// search-golf-course/index.ts to keep both functions in sync.
const API_USAGE_SCOPE_KEY = "app-wide";
// --------------------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.example.com",
  "https://golfscore.app",
  "https://www.golfscore.app",
  "http://localhost:3000",
  "http://localhost:8000",
  // Capacitor's WKWebView (iOS) serves the app from this fixed origin.
  // Capacitor Android's equivalent is "https://localhost" — add it here too
  // if/when an Android build ships.
  "capacitor://localhost"
];

function getDenoEnv() {
  return (globalThis as any).Deno?.env;
}

export function getAllowedOrigins(): string[] {
  const env = getDenoEnv();
  const configured = [
    env?.get("APP_ORIGIN"),
    env?.get("SITE_URL"),
    env?.get("WEBAPP_URL"),
    env?.get("VERCEL_URL") ? `https://${env.get("VERCEL_URL")}` : null,
    env?.get("SUPABASE_URL")
  ].filter(Boolean) as string[];

  return [...new Set([...configured, ...DEFAULT_ALLOWED_ORIGINS])];
}

export function buildCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const allowed = getAllowedOrigins();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };

  if (!requestOrigin || !allowed.includes(requestOrigin)) {
    return headers;
  }

  headers["Access-Control-Allow-Origin"] = requestOrigin;
  return headers;
}

export function validateCourseId(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    // API IDs are opaque; preserve their string form for URL paths and storage.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return null;
    return trimmed;
  }

  return null;
}

export async function authenticateRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { ok: false, status: 401, userId: null };
  }

  const token = match[1].trim();
  if (!token || token.length > 2048) {
    return { ok: false, status: 401, userId: null };
  }

  try {
    const authUrl = new URL("/auth/v1/user", supabaseUrl.endsWith("/") ? supabaseUrl : `${supabaseUrl}/`);
    const response = await fetch(authUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return { ok: false, status: 401, userId: null };
    }

    const payload = await response.json();
    const userId = typeof payload?.id === "string" ? payload.id : null;
    if (!userId) {
      return { ok: false, status: 401, userId: null };
    }

    return { ok: true, status: 200, userId };
  } catch {
    return { ok: false, status: 401, userId: null };
  }
}

const denoRuntime = (globalThis as any).Deno;
if (denoRuntime && typeof denoRuntime.serve === "function") {
  const handler = async function(req: Request) {
    const headers = buildCorsHeaders(req.headers.get("origin"));

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers });
    }

    try {
      const apiKey = getDenoEnv()?.get("GOLF_COURSE_API_KEY");
      const apiBaseUrl = (getDenoEnv()?.get("GOLF_COURSE_API_BASE_URL") || "https://api.golfcourseapi.com").replace(/\/+$/, "");
      const supabaseUrl = getDenoEnv()?.get("SUPABASE_URL");
      const anonKey = getDenoEnv()?.get("SUPABASE_ANON_KEY") ?? getDenoEnv()?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const serviceRoleKey = getDenoEnv()?.get("SUPABASE_SERVICE_ROLE_KEY");

      if (!apiKey) {
        return jsonResponse({ error: "Course lookup is temporarily unavailable" }, 500, headers);
      }

      if (!supabaseUrl || !serviceRoleKey || !anonKey) {
        return jsonResponse({ error: "Course lookup is temporarily unavailable" }, 500, headers);
      }

      const auth = await authenticateRequest(req, supabaseUrl, anonKey);
      if (!auth.ok) {
        return jsonResponse({ error: "Unauthorized" }, auth.status, headers);
      }

      let body: Record<string, unknown> = {};
      try {
        body = await req.json();
      } catch {
        body = {};
      }

      const courseId = validateCourseId(body.courseId);
      if (!courseId) {
        return jsonResponse({ error: "A valid courseId is required" }, 400, headers);
      }

      const dailyLimit = Number(getDenoEnv()?.get("COURSE_API_DAILY_LIMIT") ?? "100");
      const quotaAllowed = await consumeCourseApiQuota(supabaseUrl, serviceRoleKey, API_USAGE_SCOPE_KEY, dailyLimit);

      if (!quotaAllowed) {
        return jsonResponse({
          error: "Course lookup is temporarily unavailable — try again shortly, or enter the course manually.",
          limited: true,
          results: null
        }, 200, headers);
      }

      const remoteUrl = `${apiBaseUrl}/v1/courses/${encodeURIComponent(String(courseId))}`;
      const remoteResponse = await fetch(remoteUrl, {
        method: "GET",
        headers: {
          Authorization: `Key ${apiKey}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (remoteResponse.status === 429) {
        return jsonResponse({
          error: "Course lookup is temporarily unavailable — try again shortly, or enter the course manually.",
          limited: true,
          results: null
        }, 200, headers);
      }

      if (!remoteResponse.ok) {
        return jsonResponse({
          error: "Course lookup is temporarily unavailable",
          results: null
        }, 502, headers);
      }

      const remoteData = await remoteResponse.json();
      const normalizedCourse = normalizeCourseDetails(remoteData, courseId);

      if (!normalizedCourse) {
        return jsonResponse({
          error: "No hole data was returned by the Golf Course API",
          results: null
        }, 422, headers);
      }

      return jsonResponse(normalizedCourse, 200, headers);
    } catch {
      return jsonResponse({
        error: "Unexpected server error",
        results: null
      }, 500, headers);
    }
  };

  denoRuntime.serve(handler);
}

// Walks the "tees" object (grouped by gender, each containing an array of
// tee sets) and returns the holes array from the first tee set that has one.
// We don't care which tee/gender it comes from -- just need hole number,
// par, and handicap, which are consistent across tee sets.
export function extractHoles(tees: unknown): Array<Record<string, unknown>> {
  let found: Array<Record<string, unknown>> = [];

  const visit = (val: unknown) => {
    if (found.length > 0 || !val || typeof val !== "object") {
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) visit(item);
      return;
    }
    const obj = val as Record<string, unknown>;
    if (Array.isArray(obj.holes) && obj.holes.length > 0) {
      found = obj.holes.filter((hole): hole is Record<string, unknown> =>
        !!hole && typeof hole === "object" && !Array.isArray(hole)
      );
      if (found.length > 0) return;
    }
    for (const nested of Object.values(obj)) visit(nested);
  };

  visit(tees);
  return found;
}

// Deliberately project only fields the app consumes. New optional API fields
// (such as coordinates or hole meters) are ignored unless explicitly adopted.
export function normalizeCourseDetails(remoteData: unknown, fallbackCourseId: number | string) {
  const root = remoteData && typeof remoteData === "object"
    ? remoteData as Record<string, unknown>
    : {};
  const course = root.course && typeof root.course === "object"
    ? root.course as Record<string, unknown>
    : root;
  const holesData = extractHoles(course.tees);
  if (holesData.length === 0) return null;

  const holes = holesData.map((hole, index) => ({
    hole_number: index + 1,
    par: Number(hole.par ?? 0),
    handicap: Number(hole.handicap ?? hole.stroke_index ?? 0)
  }));

  return {
    id: course.id ?? root.id ?? fallbackCourseId,
    club_name: course.club_name ?? course.clubName ?? null,
    course_name: course.course_name ?? course.name ?? null,
    location: course.location ?? null,
    hole_count: holes.length,
    holes,
    limited: false
  };
}

async function consumeCourseApiQuota(supabaseUrl: string, serviceRoleKey: string, usageKey: string, dailyLimit: number) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_course_api_quota`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      p_usage_key: usageKey,
      p_daily_limit: dailyLimit
    })
  });

  if (!response.ok) {
    throw new Error(`Quota check failed: ${response.status}`);
  }

  const data = await response.json();
  return data === true;
}

function jsonResponse(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
