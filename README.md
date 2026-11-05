# NORTHLINE

A student-facing tool that takes matric marks, FSc Part 1 marks, field of
study, and preferred city, and suggests university/program preferences —
with eligibility against historical closing merits once that data is added.

**Note: this README describes an early prototype state and is out of date
in several places (e.g. it predates `pathways.html`, `rankings.html`, and
`merit.html`, and Supabase is now used throughout, not "no database").
See `PROGRESS.md` for the current, maintained picture of the project —
trust that file over this one where they disagree.**

`index.html` was originally a standalone marks-in/universities-out
calculator; it's now the post-login dashboard and no longer collects
marks itself (see `PROGRESS.md`).

## Run it

Clone the repo and open `index.html` directly in a browser. No server,
no `npm install`, nothing to build.

## Structure

```
Future-Pathways/
├── index.html              — page shell, form markup
├── styles/
│   ├── base.css             — tokens: colors, type, resets
│   ├── layout.css           — structure/grid only
│   └── components.css      — inputs, buttons, cards, badges, gauge
├── js/
│   ├── data.js              — fields, cities, merit weights, UNIVERSITIES dataset
│   ├── calculations.js     — pure functions: percentages, provisional merit score
│   ├── suggestions.js      — matches/ranks universities against a student profile
│   ├── supabase-client.js — only file that talks to Supabase (insert-only)
│   ├── ui.js                — DOM rendering
│   └── app.js              — form event wiring, glues the modules together
└── supabase/
    └── schema.sql          — run once in the Supabase SQL Editor
```

## Database (Supabase)

Every submission is written to a `student_submissions` table in Supabase
instead of staying only in the browser.

**One-time setup:** open your Supabase project → SQL Editor → paste and
run `supabase/schema.sql`. It creates the table, adds a Row Level
Security policy so the public key can only **insert** rows, and grants
the `anon` role the actual Postgres `insert` privilege — RLS policies
alone don't expose a table to the Data API; the explicit `grant` is
required too, and it's easy to miss. View collected submissions from the
Supabase dashboard's Table Editor, which has full access regardless of
RLS.

`js/supabase-client.js` holds the project URL and the **publishable
(anon) key** — this key is meant to be public/client-side, unlike the
service role key or database password, which should never go in this
repo or in browser code.

## Sign-in alerts

In the NORTHLINE Supabase project, deploy `supabase/functions/send-login-alert/index.ts` as `send-login-alert`. Disable the gateway's legacy **Verify JWT** setting for this function. The handler validates the user's Supabase token before sending.

Set the Edge Function secrets `RESEND_API_KEY` (a sending key for `keystonelabs.site`) and `ALERT_RECIPIENTS_BY_INSTITUTION`. The second secret is a JSON object keyed by `public.institutions.id`, for example `{"institution-uuid":["admin@example.com"]}`. Use only the intended recipients for each institution. Unconfigured institutions receive no alerts.

Sign out and sign back in with a test account assigned to a configured institution. Check Resend's email log and the recipient's inbox for a message from `northline-alerts@keystonelabs.site`.

## How it works

1. Student enters name, matric obtained/total, FSc Part 1 obtained/total,
   field of study, preferred city.
2. `calculations.js` computes a **provisional merit score** per field
   (weights in `Counsellor.MERIT_WEIGHTS`, `js/data.js`) — matric + FSc
   Part 1 only, since Part 2 and the entry test aren't available yet. It
   reports a "score so far" and a "best-case ceiling" (if the pending
   entry-test weight were scored at 100%).
3. `suggestions.js` filters `Counsellor.UNIVERSITIES` by field, ranks
   preferred-city matches first, and classifies each program as Strong
   Chance / Competitive / Unlikely / Merit data needed by comparing the
   score against that program's `closingMerit`.
4. `ui.js` renders the results as cards with a radial score gauge.

## Adding real data

`js/data.js` is the only file meant to change often. Every
`closingMerit` is currently `null` on purpose, so cards show "Merit data
needed" instead of a guess. Fill in real historical closing merits per
program and the cards automatically switch to a real classification — no
other file needs touching.

## Not in this prototype

- No historical merit data (placeholders only — see above)

## NORTHLINE form (`pathways.html`, `auth.html`, `admin.html`)

A separate, full multi-step preference-submission flow sits alongside the
quick merit calculator above. It has its own auth, own Supabase tables,
and its own JS modules — it does not touch `student_submissions` or the
calculator's files.

```
auth.html          — student sign up / log in (Supabase Auth)
pathways.html       — the multi-step form itself
admin.html          — counsellor/admin: list submissions, filter, enter
                       the 12-recommendation office evaluation
js/fp-client.js     — shared Supabase client + auth helpers
js/fp-app.js        — student form: steps, validation, draft save, submit
js/fp-admin.js       — admin list + detail + evaluation form
styles/pathways.css — styles for all three pages (reuses base.css tokens)
supabase/future_pathways_schema.sql — tables, roles, RLS (run once)
supabase/future_pathways_seed.sql   — institutes/faculties/programs/careers (run once, after schema)
```

**One-time setup**, in the Supabase SQL Editor, in order:
1. `supabase/schema.sql` (if not already run)
2. `supabase/future_pathways_schema.sql`
3. `supabase/future_pathways_seed.sql`

New signups default to the `student` role (via a trigger on
`auth.users`). To make someone a counsellor/admin, update their row in
`app_users` from the Supabase dashboard: `update public.app_users set
role = 'counsellor' where id = '<their auth uid>';`

**Flow:** student information → pathway (engineering/medical) →
programs & career interests → ranked institute preferences (4 groups of
5 for engineering, 2 of 5 for medical) → ranked faculty preferences
(same grouping) → additional information → review → submit. Each step
autosaves to a `future_pathways` draft row; a partial unique index
blocks a second *submitted* row per student. Once submitted, RLS blocks
further edits from the student side.

**Ranking UI note:** preference ranking uses one dropdown per rank slot
(with duplicate-selection warnings) rather than drag-and-drop, to keep
this a no-build-step, vanilla-JS project. Swap in a drag-and-drop
library later if wanted — the data model (`preference_group`, `rank`)
doesn't need to change.

**Not done yet:** admin management UI for adding/editing institutes,
faculties, and program/career options (currently edited directly via
`supabase/future_pathways_seed.sql` or the Supabase dashboard).

## Merit & Entry Test Guide (`merit.html`)

A dedicated, searchable database of how each institute actually
calculates admission merit — matric/HSSC weightages, the entry test
required, sourced from each institute's own prospectus/admissions page.
This is a flagship feature, not an afterthought: it's in the nav on
every page, and every place an institute name appears (the "View all
universities" modal on `index.html` and `pathways.html`) has an inline
"View merit formula" toggle pulling from the same data.

```
merit.html          — the dedicated guide: search + pathway/test filters
js/fp-merit.js      — shared loader + card/weight-bar renderer (used by
                       merit.html AND the inline toggles elsewhere)
js/merit-guide.js   — controller for merit.html only (filters, grouping)
styles/merit.css    — weight bars, confidence badges, filter controls
supabase/merit_formulas_schema.sql     — table, RLS, grant (run once)
supabase/merit_formulas_seed_data.sql  — 84 formula rows, generated from
                                          a sourced CSV (run once, after
                                          the schema file)
```

**One-time setup**, in the Supabase SQL Editor, after the Future
Pathways setup above:
1. `supabase/merit_formulas_schema.sql`
2. `supabase/merit_formulas_seed_data.sql`
3. Run `select public.link_merit_formulas_to_institutes();` once, to
   link each formula row to its `institutes` row by matching name +
   pathway (best-effort; the guide works fine even before this runs,
   it just enables future features that need the FK).

**Data shape:** one institute can have *multiple* formula rows — e.g.
NUST has a separate formula for NET-basis vs ACT/SAT-basis admission;
ITU has three depending on the program. Some institutes (LUMS, IBA,
NCA, PIFD, Aga Khan) have **no fixed percentage formula** — admission
is holistic — and the UI shows that plainly instead of faking a
weight bar. Every row also carries a `confidence` rating and a
`source_url`; treat `Medium` confidence rows as needing a manual
re-check before relying on them.

**Not done yet:** deep-linking the merit formula into the actual
ranked-institute-preference step of the form (right now it's the "View
all universities" modal only, on both pages); an admin UI for editing
formulas (edit via `supabase/merit_formulas_seed_data.sql` or the
Supabase dashboard for now); re-verifying `2026-27`-dated rows before
next admission cycle, since a couple of institutes' policies are
already dated ahead.

## "View all universities" modal — search + per-institute programs

The modal (opened from `index.html`'s dashboard and from `pathways.html`)
now has:

- **Search by university name** — a search box + button above the
  Engineering/Medical grouped list, filters live as you type or on
  Search/Enter.
- **"View programs" toggle per institute** — expands to show program/
  scope names for that specific institute, with its own search box +
  button to filter that list. This reuses `merit_formulas.program_scope`
  (falling back to `.basis`) — the same sourced data behind the Merit
  Guide — rather than a separate, unverified program catalog. If an
  institute has no merit-formula rows, it honestly says so instead of
  showing an empty or fabricated list. `FP.getProgramsForInstituteName`
  / `FP.renderProgramsSectionForInstitute` / `FP.filterProgramsSection`
  in `js/fp-merit.js` are shared by both pages' modals.

## Load-test seed data

```
supabase/load_test_seed_100_students.sql   — 100 real students, synthetic
                                              accounts, submitted forms
supabase/load_test_cleanup.sql             — deletes it all, one statement
```

100 real students (from an actual "1st Year Result — Pre-Board" school
export), split 34 Pre-Medical / 33 Pre-Engineering / 33 ICS, each with a
minimal synthetic `auth.users` row (required — `future_pathways.student_id`
chains through `students` → `app_users` → `auth.users`, so there's no way
to seed a submission without a real auth row backing it) and a fully
submitted NORTHLINE form with randomized-but-schema-valid ranked
institute/faculty/program preferences.

**What's real vs synthetic, explicitly:** student name, section, roll
number, matric marks, and first-year (Pre-Board internal) marks are the
real values from the source file. `father_name`, `father_profession`,
and `contact` are left `NULL` — that data isn't in the source file and
wasn't invented. The ranked preferences are randomly generated (that's
the point — simulating submission volume, not real intent). Every
account uses an `@loadtest.rah.internal` email specifically so it can
never be mistaken for a real user and is trivial to bulk-delete.

**This touches Supabase's internal `auth.users` schema directly** via
plain SQL (no service-role script, no Admin API) — this is the only
way to satisfy the FK chain from pure SQL. It hasn't been verified
against this project's exact live `auth` schema version. Run the first
3–5 student blocks first, confirm a clean result in the Table Editor,
then run the rest. The accounts are deliberately not login-capable (no
`auth.identities` row, no real password hash) since this is a data-
volume/query-performance test, not an auth-flow test.

Run `load_test_cleanup.sql` when done — it's a single `DELETE FROM
auth.users WHERE email LIKE '%@loadtest.rah.internal'`, which cascades
through every table above it via the existing `ON DELETE CASCADE`
chain.
