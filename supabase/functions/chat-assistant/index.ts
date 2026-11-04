// =========================================================
// supabase/functions/chat-assistant/index.ts
//
// Proxies chat requests to Groq's free-tier API. This has to live
// server-side (a Supabase Edge Function, not client JS) because the
// Groq API key would otherwise sit in plain view in the browser --
// anyone could open DevTools, copy it, and burn the shared free
// quota (or get it revoked for ToS violations).
//
// Two things this function is responsible for beyond "call the LLM":
//
// 1. Rate limiting -- Groq's free tier is shared across the WHOLE
//    app (one key), not per user. Without a cap here, one counsellor
//    could exhaust the daily/per-minute quota for everyone else.
//    Limits are enforced against public.chatbot_requests (see
//    supabase/chatbot_schema.sql) -- a request is logged BEFORE the
//    Groq call, closing most of the race-condition window where
//    parallel requests could all slip past the count check.
//
// 2. Grounding -- rather than letting the model freely answer
//    factual questions (which risks hallucinated merit formulas or
//    invented student data), real rows from merit_formulas or a
//    specific student's actual preferences are fetched and injected
//    into the system prompt first.
//
// Deploy with:
//   supabase functions deploy chat-assistant
//   supabase secrets set GROQ_API_KEY=your_key_here
// (SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by the Supabase platform -- no need to set
// those yourself.)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Adjust these two numbers to taste -- they're the only rate-limit
// knobs. Groq's free tier for openai/gpt-oss-120b is generous
// (thousands of requests/day), so these are conservative per-user
// caps meant to stop one person from hogging it, not to ration a
// scarce resource.
const HOURLY_LIMIT = 15;
const SIX_HOUR_LIMIT = 40;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const SYSTEM_PROMPT = `You are a helpful assistant embedded in NORTHLINE, an internal tool KIPS College counsellors use to help students plan university/college applications.

How the site works, for context:
- Students fill out a form ranking their preferences: institutes, faculties, and programs, in 4 groups of 5 ranked choices each (20 total ranked positions -- 2 groups / 10 positions for the medical pathway). Group 1 = positions 1-5, Group 2 = positions 6-10, Group 3 = positions 11-15, Group 4 = positions 16-20.
- Counsellors review submissions in an admin dashboard, and can step through any of the 20 ranked positions to see which institute/faculty a student chose there.
- The site also has a Merit & Entry Test Guide (weighted merit formulas per institute), a Merit Calculator (students plug in marks to estimate their aggregate), and closing merit records (last year's actual cutoffs).

You have access to real data injected below as context when relevant: student profiles (name, contact, marks, all preference ranks, counsellor evaluation notes), merit formulas, closing merit cutoffs, and the institute/faculty/program/career catalog. This may include personal contact information (phone numbers) and marks -- that's expected and appropriate, since you're only ever talking to an authenticated counsellor/admin who already has access to this same data throughout the rest of the site.

You're talking to a counsellor or admin, not a student. Be concise, direct, and practical. If you don't know something (e.g. a specific institute's current admission deadline), say so plainly rather than guessing -- do not invent merit formulas, cutoffs, policies, or student records that weren't given to you in context below. If asked to find a student and no matching records appear in context, say clearly that no match was found rather than guessing a name.`;

async function buildStudentContext(adminClient: any, studentId: string): Promise<string> {
  const { data: fp } = await adminClient
    .from("future_pathways")
    .select("id, pathway, status, additional_information, submitted_at, students(*)")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!fp) return "No NORTHLINE submission found for this student.";

  const [instPrefs, facPrefs, progPrefs, evalRes] = await Promise.all([
    adminClient.from("student_institute_preferences")
      .select("preference_group, rank, custom_institute_name, institutes(name)")
      .eq("future_pathway_id", fp.id).order("preference_group").order("rank"),
    adminClient.from("student_faculty_preferences")
      .select("preference_group, rank, custom_faculty_name, fp_faculties(name)")
      .eq("future_pathway_id", fp.id).order("preference_group").order("rank"),
    adminClient.from("student_program_preferences")
      .select("rank, custom_program_name, program_options(name)")
      .eq("future_pathway_id", fp.id).order("rank"),
    adminClient.from("office_evaluations").select("*").eq("future_pathway_id", fp.id).maybeSingle(),
  ]);

  function fmtRows(rows: any[] | null, customKey: string, lookupKey: string) {
    return (rows || []).map((r: any) => {
      const pos = (r.preference_group - 1) * 5 + r.rank;
      const name = r[customKey] || r[lookupKey]?.name || "(unset)";
      return pos + ". " + name;
    }).join("\n") || "(none set)";
  }

  const student = fp.students || {};
  const evalRow = evalRes.data || {};
  const recommendations = Array.from({ length: 12 }, (_, i) => evalRow["recommendation_" + (i + 1)]).filter(Boolean);

  const programLines = (progPrefs.data || []).map((r: any) =>
    r.rank + ". " + (r.custom_program_name || r.program_options?.name || "(unset)")
  ).join("\n") || "(none set)";

  return [
    "Current student being discussed (full profile -- real data):",
    "Name: " + (student.student_name || "(unknown)"),
    "Father's name: " + (student.father_name || "n/a") + ", Father's profession: " + (student.father_profession || "n/a"),
    "Contact: " + (student.contact || "n/a"),
    "Discipline: " + (student.discipline || "n/a") + ", Section: " + (student.section || "n/a") + ", Roll number: " + (student.roll_number || "n/a"),
    "Pathway: " + fp.pathway,
    "Status: " + fp.status + (fp.submitted_at ? " (submitted " + fp.submitted_at + ")" : ""),
    "Matric marks: " + (student.matric_marks ?? "n/a") + ", First year marks: " + (student.first_year_marks ?? "n/a"),
    "Additional information from student: " + (fp.additional_information || "none provided"),
    "",
    "Institute preferences (position. name):",
    fmtRows(instPrefs.data, "custom_institute_name", "institutes"),
    "",
    "Faculty preferences (position. name):",
    fmtRows(facPrefs.data, "custom_faculty_name", "fp_faculties"),
    "",
    "Program/career preferences (rank. name):",
    programLines,
    "",
    recommendations.length ? "Counsellor office evaluation notes: " + recommendations.join("; ") : "",
    evalRow.remarks ? "Office remarks: " + evalRow.remarks : "",
    evalRow.counsellor_name ? "Evaluated by: " + evalRow.counsellor_name : "",
  ].filter(function(line){ return line !== ""; }).join("\n");
}

async function buildFaqContext(adminClient: any, message: string): Promise<string> {
  const [meritBlock, closingBlock, catalogBlock, studentBlock] = await Promise.all([
    buildMeritContext(adminClient, message),
    buildClosingMeritContext(adminClient, message),
    buildCatalogContext(adminClient, message),
    buildStudentSearchContext(adminClient, message),
  ]);
  return [studentBlock, meritBlock, closingBlock, catalogBlock].filter(Boolean).join("\n\n");
}

async function buildMeritContext(adminClient: any, message: string): Promise<string> {
  // Lightweight grounding: pull merit formula rows whose institute
  // name appears (loosely) in the question, so answers about a
  // specific university's formula are backed by real stored data
  // instead of the model guessing/hallucinating a formula.
  const { data: formulas } = await adminClient
    .from("merit_formulas")
    .select("institute_name_raw, basis, program_scope, formula_text, weightages_text, effective_year")
    .limit(200);

  if (!formulas || !formulas.length) return "";

  const words = message.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3);
  const matches = formulas.filter((f: any) => {
    const name = (f.institute_name_raw || "").toLowerCase();
    return words.some((w: string) => name.indexOf(w) !== -1);
  }).slice(0, 5);

  if (!matches.length) return "";

  return "Relevant merit formula records (use these, don't invent numbers):\n" +
    matches.map((f: any) =>
      "- " + f.institute_name_raw + (f.program_scope ? " (" + f.program_scope + ")" : "") +
      ": " + f.formula_text +
      (f.weightages_text ? " | Weightages: " + f.weightages_text : "") +
      (f.effective_year ? " | Effective: " + f.effective_year : "")
    ).join("\n");
}

async function buildClosingMeritContext(adminClient: any, message: string): Promise<string> {
  // Same keyword-match approach as merit formulas, against last
  // cycle's actual closing-merit cutoffs -- lets the assistant answer
  // "what was the closing merit for X last year" with real numbers.
  const { data: records } = await adminClient
    .from("closing_merit_records")
    .select("university_name_raw, campus, program, closing_merit_percentage, admission_year, data_status")
    .eq("active", true)
    .limit(300);

  if (!records || !records.length) return "";

  const words = message.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3);
  const matches = records.filter((r: any) => {
    const name = ((r.university_name_raw || "") + " " + (r.program || "")).toLowerCase();
    return words.some((w: string) => name.indexOf(w) !== -1);
  }).slice(0, 8);

  if (!matches.length) return "";

  return "Relevant closing merit records (real cutoffs, use these -- don't invent a percentage):\n" +
    matches.map((r: any) =>
      "- " + r.university_name_raw + (r.campus ? " (" + r.campus + ")" : "") +
      " -- " + r.program + ": " +
      (r.closing_merit_percentage != null ? r.closing_merit_percentage + "%" : "not found") +
      " (" + r.admission_year + ", " + r.data_status + ")"
    ).join("\n");
}

async function buildCatalogContext(adminClient: any, message: string): Promise<string> {
  // General "what institutes/faculties/programs/careers exist" style
  // questions -- e.g. "does NUST offer X faculty", "what careers are
  // listed under medical". Runs all four lookup tables in parallel,
  // keyword-matched the same way as the other grounding sources.
  const words = message.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3);
  if (!words.length) return "";

  const [inst, fac, prog, career] = await Promise.all([
    adminClient.from("institutes").select("name, location, pathway").eq("active", true).limit(300),
    adminClient.from("fp_faculties").select("name, pathway").eq("active", true).limit(300),
    adminClient.from("program_options").select("name, category, pathway").eq("active", true).limit(300),
    adminClient.from("career_options").select("name, category").eq("active", true).limit(300),
  ]);

  function matchRows(rows: any[] | null, nameKey: string) {
    return (rows || []).filter((r: any) => {
      const name = (r[nameKey] || "").toLowerCase();
      return words.some((w: string) => name.indexOf(w) !== -1);
    }).slice(0, 8);
  }

  const instMatches = matchRows(inst.data, "name");
  const facMatches = matchRows(fac.data, "name");
  const progMatches = matchRows(prog.data, "name");
  const careerMatches = matchRows(career.data, "name");

  const blocks: string[] = [];
  if (instMatches.length) {
    blocks.push("Matching institutes:\n" + instMatches.map((r: any) =>
      "- " + r.name + (r.location ? " (" + r.location + ")" : "") + " -- " + r.pathway
    ).join("\n"));
  }
  if (facMatches.length) {
    blocks.push("Matching faculties:\n" + facMatches.map((r: any) => "- " + r.name + " (" + r.pathway + ")").join("\n"));
  }
  if (progMatches.length) {
    blocks.push("Matching programs:\n" + progMatches.map((r: any) =>
      "- " + r.name + (r.category ? " (" + r.category + ")" : "") + " -- " + r.pathway
    ).join("\n"));
  }
  if (careerMatches.length) {
    blocks.push("Matching careers:\n" + careerMatches.map((r: any) => "- " + r.name + (r.category ? " (" + r.category + ")" : "")).join("\n"));
  }

  return blocks.join("\n\n");
}

// Lets the general chat (no studentId scoped) answer "find student
// named X" style questions directly, instead of only being able to
// summarize a student when opened via the per-student "Ask
// assistant" button. Candidate words come from the message itself,
// stripped down to just plausible name tokens -- common query words
// ("find", "student", "show"...) are filtered out so they don't get
// matched against student_name as if they were part of a name.
const STUDENT_SEARCH_STOPWORDS = new Set([
  "find","student","students","named","search","looking","look","show",
  "list","tell","about","who","the","for","name","please","info",
  "information","details","this","that","with","from","give","get","has",
]);

async function buildStudentSearchContext(adminClient: any, message: string): Promise<string> {
  const words = message.toLowerCase().split(/\W+/)
    .filter((w: string) => w.length > 2 && !STUDENT_SEARCH_STOPWORDS.has(w));
  if (!words.length) return "";

  // Safe to interpolate directly into .or() -- the \W+ split above
  // already stripped every character except letters/digits/underscore
  // out of each token, so there's no way a comma, parenthesis, or
  // other filter-syntax character survives into the query string.
  const orFilter = words.map((w: string) => "student_name.ilike.%" + w + "%").join(",");
  const { data: students } = await adminClient
    .from("students")
    .select("id, student_name")
    .or(orFilter)
    .limit(10);

  if (!students || !students.length) return "";

  // Few matches -- pull the FULL per-student profile (same detail as
  // the per-student "Ask assistant" mode) for each, so a question
  // like "what's Maheen's contact number" can be answered directly
  // instead of pointing back to the admin dashboard.
  if (students.length <= 3) {
    const blocks = await Promise.all(students.map((s: any) => buildStudentContext(adminClient, s.id)));
    return blocks.join("\n\n---\n\n");
  }

  // Too many matches for full detail without blowing up the prompt --
  // list names + pathway/status so the person can narrow it down.
  const ids = students.map((s: any) => s.id);
  const { data: fps } = await adminClient
    .from("future_pathways")
    .select("student_id, pathway, status")
    .in("student_id", ids);

  const fpByStudent: Record<string, any> = {};
  (fps || []).forEach((f: any) => { fpByStudent[f.student_id] = f; });

  return "Multiple matching students found (" + students.length + ") -- ask which one specifically:\n" +
    students.map((s: any) => {
      const fp = fpByStudent[s.id];
      return "- " + s.student_name + (fp ? " | " + fp.pathway + " | " + fp.status : " | no submission yet");
    }).join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    // Bound to the CALLER's own JWT -- used only to verify identity
    // and role via normal RLS. Never used to read/write anything the
    // caller wouldn't already be allowed to.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid session" }, 401);
    const userId = userData.user.id;

    const { data: profile } = await userClient.from("app_users").select("role").eq("id", userId).single();
    const role = profile?.role || "student";
    if (role !== "counsellor" && role !== "admin") {
      return json({ error: "This assistant is available to counsellors and admins only." }, 403);
    }

    // Service-role client -- only for rate-limit bookkeeping and
    // (when a studentId is given) fetching that student's record.
    // Safe to use here specifically because the role check above
    // already confirmed the caller is staff; this doesn't bypass any
    // permission the caller shouldn't have.
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();

    const [hourRes, sixHourRes] = await Promise.all([
      adminClient.from("chatbot_requests").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", oneHourAgo),
      adminClient.from("chatbot_requests").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", sixHoursAgo),
    ]);
    const hourCount = hourRes.count || 0;
    const sixHourCount = sixHourRes.count || 0;

    if (hourCount >= HOURLY_LIMIT) {
      return json({ error: "Rate limit reached: " + HOURLY_LIMIT + " questions per hour. Try again later." }, 429);
    }
    if (sixHourCount >= SIX_HOUR_LIMIT) {
      return json({ error: "Rate limit reached: " + SIX_HOUR_LIMIT + " questions per 6 hours. Try again later." }, 429);
    }

    const body = await req.json();
    const message = String(body.message || "").trim().slice(0, 2000);
    const studentId = body.studentId ? String(body.studentId) : null;
    if (!message) return json({ error: "Empty message" }, 400);

    const contextBlock = studentId
      ? await buildStudentContext(adminClient, studentId)
      : await buildFaqContext(adminClient, message);

    const systemPrompt = SYSTEM_PROMPT + (contextBlock ? "\n\n" + contextBlock : "");

    // Logged BEFORE the Groq call so a burst of parallel requests
    // can't all read the same pre-insert count and slip through.
    await adminClient.from("chatbot_requests").insert({ user_id: userId });

    if (!GROQ_API_KEY) {
      return json({ error: "Chat assistant isn't configured yet (missing GROQ_API_KEY secret)." }, 500);
    }

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.3,
        max_tokens: 700,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", groqRes.status, errText);
      return json({ error: "The assistant is temporarily unavailable. Try again shortly." }, 502);
    }

    const groqData = await groqRes.json();
    const reply = groqData.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";

    return json({
      reply,
      remaining: { hour: HOURLY_LIMIT - hourCount - 1, sixHour: SIX_HOUR_LIMIT - sixHourCount - 1 },
    });
  } catch (err) {
    console.error("chat-assistant error:", err);
    return json({ error: "Something went wrong." }, 500);
  }
});
