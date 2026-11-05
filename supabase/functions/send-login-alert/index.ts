import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number) {
  return new Response(null, { status, headers: cors });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return reply(204);
  if (request.method !== "POST") return reply(405);

  const token = request.headers.get("Authorization")?.match(/^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/i);
  if (!token) return reply(401);

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const recipientConfig = Deno.env.get("ALERT_RECIPIENTS_BY_INSTITUTION");
  if (!resendKey || !recipientConfig) {
    console.error("NORTHLINE login alert secrets are missing");
    return reply(503);
  }

  try {
    const authorization = token[0];
    const jwt = authorization.slice(7);
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await client.auth.getUser(jwt);
    if (authError || !user?.email) return reply(401);

    // Supabase has verified the JWT. Only a recent password sign-in can send an alert.
    const claims = JSON.parse(atob(token[2].replace(/-/g, "+").replace(/_/g, "/")));
    const signedInAt = Array.isArray(claims.amr)
      ? claims.amr.find((entry: { method: string }) => entry.method === "password")?.timestamp
      : undefined;
    const age = Date.now() / 1000 - signedInAt;
    if (!claims.session_id || !Number.isInteger(signedInAt) || age < -30 || age > 300) return reply(403);

    const { data: institutionId, error: institutionError } = await client.rpc("current_institution_id");
    if (institutionError) throw institutionError;
    if (!institutionId) return reply(204);

    const recipients = JSON.parse(recipientConfig)[institutionId];
    if (!Array.isArray(recipients) || recipients.length === 0) return reply(204);

    const result = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `northline-login/${claims.session_id}`,
      },
      body: JSON.stringify({
        from: "NORTHLINE Alerts <northline-alerts@keystonelabs.site>",
        to: recipients,
        subject: "NORTHLINE sign-in alert",
        text: `A NORTHLINE account signed in.\n\nAccount: ${user.email}\nTime: ${new Date(signedInAt * 1000).toISOString()}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) {
      console.error("Resend rejected NORTHLINE login alert", result.status);
      return reply(502);
    }
    return reply(204);
  } catch {
    console.error("NORTHLINE login alert failed");
    return reply(500);
  }
});
