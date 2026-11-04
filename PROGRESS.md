# PROGRESS.md — ground truth as of this commit

This file exists so a new Claude session (or you, months later) doesn't
have to reconstruct the state of this project from chat history. If
anything here conflicts with what a chat says, **trust this file and
the actual repo/database — re-verify by cloning fresh and checking
Supabase directly.**

## What this project is

"Rah" — a Pakistani university/college counselling tool. Two things
live in one repo:

1. **The dashboard** (`index.html`) — the landing page after login.
   Used to be a "quick calculator" (matric + FSc Part 1 marks in,
   provisional merit score + suggested universities out) — that was
   the original prototype, but it duplicated the marks intake already
   in NORTHLINE and the field/university browsing already in
   University Explorer, so it was removed. `index.html` is now a real
   dashboard: it reads the student's existing `students` row and
   latest `future_pathways` row from Supabase (no re-asking) and shows
   their actual application status (not started / draft / submitted)
   plus quick links into the three tools below. Logic lives in
   `js/dashboard.js`; the old calculator-only files (`js/app.js`,
   `js/calculations.js`, `js/suggestions.js`, `js/supabase-client.js`,
   `js/ui.js`) were deleted. `js/data.js` (institute loader) is kept —
   the dashboard's "View all universities" modal still uses it.
2. **NORTHLINE** (`pathways.html` + `admin.html`) — the real
   product: digitizes an actual paper counselling form used by a
   school. Multi-step form, ranked institute/faculty preferences,
   draft autosave, one-submission-per-student, counsellor/admin
   evaluation panel.
3. **University Explorer** (`rankings.html`) — browse field/
   specialization rankings independent of any student's own marks.

Both require login (`login.html`) — Supabase Auth, email/password only,
**no self-signup**. Accounts are created manually in the Supabase
dashboard (Authentication → Add user), mirroring how a separate project
called AXIOM does auth. New signups (if any) default to role='student'
via a database trigger.

A third thing, added most recently: **the Merit & Entry Test Guide**
(`merit.html`) — a searchable database of exactly how ~30 institutes
calculate admission merit (weightages, entry tests, sourced). See the
README's "Merit & Entry Test Guide" section for the full breakdown.

## No build step, anywhere

Every page is plain HTML + vanilla JS loaded via `<script src="...">`
tags, no bundler, no npm install. Supabase client comes from a CDN
(`@supabase/supabase-js@2` via jsdelivr). This is deliberate — keep it
that way unless there's a real reason to add a build step.

## Supabase setup order (run once, in this order, in SQL Editor)

1. `supabase/schema.sql` — the original `student_submissions` table
   (used only by the old quick-calculator's save-to-DB feature)
2. `supabase/future_pathways_schema.sql` — the real schema: `students`
   / `app_users`, `institutes`, `fp_faculties`, `career_options`,
   `program_options`, `future_pathways`, preference tables,
   `office_evaluations`, RLS, the `on_auth_user_created` trigger
3. `supabase/future_pathways_seed.sql` — institutes/faculties/careers
   master data (safe to re-run, starts with TRUNCATE ... CASCADE)
4. `supabase/fix_category_constraint.sql` — widens
   `institutes.category` to allow `nums`/`private`/`other` subtypes
   (needed before step 3's data will insert cleanly — **if starting
   from scratch, run this before step 3**, not after)
5. `supabase/merit_formulas_schema.sql` — the merit guide table, RLS
6. `supabase/merit_formulas_seed_data.sql` — 84 formula rows
7. `select public.link_merit_formulas_to_institutes();` — one-time
   call to link merit rows to institute rows by name match

`supabase/restore_auth_policies.sql` is a **patch**, not part of the
normal setup order — it exists because auth/RLS was toggled to open
access at one point while debugging, then reverted. Only relevant if
you're diagnosing why RLS looks wrong.

**A real gotcha that already bit this project once:** an RLS policy
alone does NOT expose a table to Supabase's Data API. You also need an
explicit Postgres `grant ... to authenticated` (or `anon`, depending on
the table). Every schema file in this repo already includes the grants
— if you add a new table by hand, don't forget this or every
insert/select will silently fail with no obvious error.

## Naming quirks worth knowing before you get confused

- The faculties table is `fp_faculties`, not `faculties` — renamed to
  avoid colliding with an unrelated legacy table.
- `institutes.category` values are `engineering`, `medical`, `nums`,
  `private`, `other` — dental colleges are folded into `medical`, not
  a separate category.
- Student role table is `app_users` (referenced in `fp-client.js`),
  though some SQL comments/older text may still say `profiles` — that
  was an earlier name during initial scaffolding and was renamed.
- `Fazal Medical College` (not "Fazaia") is the correct name — this
  was deliberately fixed to match the source data.
- The staff/role-check RLS helper is `public.current_role()` — it
  returns the role as **text** (`'student'` / `'counsellor'` /
  `'admin'`), used as `public.current_role() in ('counsellor','admin')`
  inside policies. It is **not** called `is_staff()` and does **not**
  return a boolean — an earlier merit-formulas schema draft used
  `is_staff()` by mistake (copied from a different, discarded draft of
  this project) and failed with `function public.is_staff() does not
  exist` when run. Match the real function name and signature exactly
  before writing new RLS policies.
- Master-data read policies (`institutes`, `fp_faculties`,
  `program_options`, `career_options`, `merit_formulas`) grant `select`
  to **both** `anon` and `authenticated` — so these lists can render
  before login — while `insert`/`update`/`delete` are granted to
  `authenticated` only and further gated by `current_role()` in RLS.
  Match this exact anon/authenticated split for any new master-data
  table; don't default to `authenticated`-only for reads.

## Known intentional gaps (not bugs)

- `Counsellor.MERIT_FEATURE_ENABLED = false` in `js/data.js` is now
  **dead** — it only gated the old quick calculator's Strong/
  Competitive/Unlikely scoring, and that calculator (`js/suggestions.js`
  etc.) was deleted when `index.html` became a dashboard. Safe to
  remove along with the rest of `Counsellor.FIELDS` / `AREAS` /
  `MERIT_WEIGHTS` next time someone's in `data.js` — left in place for
  now since `Counsellor.loadInstitutes()` / `Counsellor.INSTITUTES` in
  the same file are still used by the "View all universities" modal.
  The Merit & Entry Test Guide (`merit.html`, formulas not closing
  merits) is unrelated and already live — don't conflate the two.
- Institute ranking uses one `<select>` per rank slot, not real
  drag-and-drop. Functionally equivalent, simpler to keep dependency-
  free. Swap in a DnD library later if wanted.
- No admin UI yet for editing institutes/faculties/merit formulas —
  all master data is edited via SQL seed files or the Supabase Table
  Editor directly.
- Merit formula data is not yet surfaced inside the actual ranked-
  institute-preference step of the form — only in the "View all
  universities" modal and the dedicated `merit.html` page.

## Frontend design pass (Manifest)

`pathways.html` now has a live-updating "Manifest" side rail
(`#fp-progress` repurposed, see `renderProgress()` / `manifestValue()`
in `js/fp-app.js`) — each line reflects real form state, not just step
position. At the review step it becomes the finale: `.fp-layout`
collapses to one column, `body.is-review-step` styling kicks in, the
submit button becomes `.btn-transmit` ("Transmit application"), and a
mono UTC timestamp stamps in on success (`state.submittedAt`).
`admin.html` got a `#fp-stats-strip` (total/submitted/draft/by-pathway
counts, computed client-side from the already-loaded `submissions`
array — no new query). No IDs or data flow changed; this was a
CSS + presentation-layer pass on top of the existing logic.

## Home dashboard: "Recently saved student forms" widget

`index.html` now has a small `#fp-dash-section` (new
`js/fp-saved-forms.js`) below the tool cards, showing the 8
most-recently-saved `future_pathways` rows with a click-to-open
read-only preview modal (profile, careers, ranked institute/faculty
preferences). It's `hidden` by default and only unhidden when the
signed-in `app_users.role` is `counsellor` or `admin` — same gate
`admin.html`/`js/fp-admin.js` already uses, checked client-side only
(RLS on the underlying tables is what actually enforces this).

This does **not** replace `admin.html` — that page still has the full
filterable table, submission stats strip, and office-evaluation
editing. The new widget is a lightweight glance + link out to
`admin.html` for anyone who wants the full view, since `admin.html`
isn't linked from the main nav.

## If something seems broken

Don't trust old chat descriptions of "current state" — clone the repo
fresh and read the actual files and `git log`. Check the live Supabase
tables directly (Table Editor) rather than assuming a schema file was
actually run. Check the live Vercel deployment's commit hash against
`git log` before assuming a fix is live.

## Page-load performance fix (auth-blocking-content pattern)

Every page had the same bug: `FP.requireAuth()` does two sequential
round-trips internally (session, then a separate `app_users` role
lookup), and every page's own content queries waited behind the
**full** result of that before even firing. Four sequential round-
trips stacked up on `admin.html` alone (auth → institutes/faculties/
careers → first-priorities → submissions).

Fixed by firing content queries immediately, in parallel with the
auth check, since RLS enforces access server-side regardless of when
the client-side profile fetch resolves — there's no correctness
reason for the queries to wait on each other:

- **`pathways.html` / `merit.html`** — neither page ever reads role at
  all. Dropped `FP.requireAuth()` entirely; use
  `FP.client.auth.getSession()` directly (resolves from local storage
  in the common case, no network round-trip) for the redirect-if-not-
  logged-in check + `studentId`. Content queries that don't need
  `studentId` either (`loadMasterData()`, `FP.loadMeritFormulas()`,
  `FP.loadClosingMerit()`) fire before the session is even known.
- **`index.html` / `admin.html`** — these do need role (branches UI
  on counsellor/admin vs student), so `FP.getSessionAndProfile()`
  stays, but content queries now fire in parallel with it instead of
  waiting behind it.
- **`admin.html`**'s own internal chain (`loadLookups().then(loadFirstPriorities).then(loadSubmissions)`)
  was *also* three sequential round-trips with no real dependency
  forcing that order — now all fire together, with only the
  *processing* of results sequenced (institute names need to be
  loaded before first-priority display names can be resolved, but the
  fetches themselves don't need to wait).

If a future page needs role-gated behavior and reaches for
`FP.requireAuth()` again out of habit, check whether the content
below it actually needs role before letting it block everything else.

## Recent fixes (branding, nav, casing, region search)

- Brand renamed `Rah` → `KIPS` across all 6 HTML files (verified zero
  leftover references, including JS/CSS).
- `index.html` had the same 3 links (NORTHLINE form / University
  Explorer / Merit guide) as both top-nav pills *and* body tool cards
  — removed the duplicate pills, kept the better-designed cards
  (icon + description + CTA).
- Text casing was inconsistent across `admin.html`'s table and the
  dashboard's "Recently saved forms" widget: student names in ALL CAPS
  (real source data from the school's own export), pathway/status in
  lowercase, no shared convention. Added a `titleCase()` helper
  (display-only, doesn't mutate stored data) for names, and
  `text-transform: capitalize` CSS (`.fp-cap`, and added directly to
  `.fp-badge`) for pathway/status — same fix duplicated in both
  `js/fp-admin.js` and `js/fp-saved-forms.js` since they're separate
  IIFEs with no shared module system.
- University Explorer (`rankings.html`) City filter: **first version
  of this was wrong** — built as a separate standalone search section
  below the Field/Specialization card instead of a third filter
  integrated into the same one, which wasn't what was asked for and
  was correctly rejected. Corrected version: `.fp-grid-3` (new,
  mirrors `.fp-grid-2`), City is a third `<select>` in the *same*
  `.rk-selector` card, populated from `institutes.location` +
  `institutes.campuses` (real data, fetched immediately on script
  load — this page has no auth gate). It filters the *same* ranked
  results and "Also offered at" list that Field/Specialization
  produce (via a canonical-name → cities map, reusing the existing
  `INSTITUTE_ALIAS` display-name mapping), not a separate result set.
  An institute not present in `institutes` (i.e. not in the seeded
  table, only in the curated `rankings-data.js` content) has no known
  city and is correctly excluded when a city filter is active, rather
  than guessed.

## Light theme + theme toggle

Not a color inversion — a second set of tokens sharing the same bones
(type scale, spacing, radii, the same `--violet` accent hue for
button fills) as the dark theme, recalibrated where the underlying
math actually differs between a near-black and a near-white canvas:

- **Elevation reverses.** Dark theme cards read "raised" by being
  *lighter* than canvas. That trick doesn't work near white (reads as
  dirty gray, not elevated), so light-theme cards are pure white with
  a `--shadow-card` token (`.fp-card` now has
  `box-shadow: var(--shadow-card, none)` — `none` in dark mode where
  the token isn't defined, an actual soft shadow in light mode).
- **`--violet-text` exists because contrast math isn't symmetric.**
  The brand violet (`#6E76F0`) works fine as white-on-violet button
  fill, and fine as violet-on-black body text — but fails WCAG AA
  (3.8:1, need 4.5:1) as violet text directly on a white canvas
  (links, `.eyebrow` labels). Rather than retune `--violet` itself
  and risk the button fill or dark-mode text, only that specific
  usage gets a deepened same-hue variant (`#4B44D6`, ~6.8:1 on
  white) via a separate token. `a{color}` and `.eyebrow{color}` in
  `styles/base.css` use `--violet-text`, not `--violet` directly —
  keep that distinction if adding new violet-on-canvas text anywhere.
- Green/amber/red also got darkened light-mode variants for the same
  contrast reason (status badges, error/success text).
- The ambient aurora background (`body::before/::after` +
  `html::before` noise layer in `base.css`) now reads its color stops
  from `--aurora-a-stops` / `--aurora-b-stops` / `--aurora-noise-opacity`
  tokens instead of hardcoded rgba values, so light mode can retune
  intensity (lower opacity — the same values would be too strong on
  white) without duplicating the whole layer/animation setup.

**Switching mechanism:** `data-theme="light"` attribute on
`<html>`, persisted to `localStorage` (`kips-theme`). Two parts:
1. A tiny synchronous inline script at the very top of every page's
   `<head>` (before any CSS loads) applies the saved choice
   immediately, avoiding a flash of the wrong theme on load.
2. `js/theme-toggle.js` (new, shared, loaded on every page) handles
   the actual click-to-switch and updates the toggle button's label.

**The toggle control is deliberately not a sun/moon icon-swap or a
sliding pill switch** — the two most overused patterns for this
exact UI element. It's a single circle split into a filled half and
a hollow half (`.theme-toggle-glyph`, a `conic-gradient` + border,
no SVG/icon font needed) that rotates 180° on click — one object
turning over, not two icons cutting between each other. Lives in
`styles/components.css` next to `.nav-link` (same family: pill
shape, same padding/sizing) since it's a nav-adjacent control, not a
one-off page-specific button.

**Every page has one**, positioned consistently: right before "Log
out" on the four authenticated pages (`index.html`, `pathways.html`,
`admin.html`, `merit.html`), at the end of the topbar on
`rankings.html` (no logout button there), and next to the brand mark
in `login.html`'s header (no topbar at all on that page — see
`.header-top`, the same row-layout wrapper `index.html` etc already
use around `.brand`, applied there for the first time).

**Verified visually**, not just written and trusted: rendered both
themes via headless Chromium (actual click-through, not just setting
the attribute), and a separate component-swatch render (buttons,
badges, links, error/success text, the toggle itself) side-by-side in
both themes to check contrast on the recalibrated status colors
specifically. Re-check the same way if the palette changes again.

## Counsellor-managed students (built)

**The real workflow:** a counsellor sits at a desk, brings students
up in batches, and enters each student's info + preferences directly
on their behalf, in one sitting. Confirmed directly with the person
doing this job: the student never logs in themselves at all — the
counsellor manages everything.

**Root cause of the original bug report** ("it treats me like I'm a
student and won't let me edit, but the admin panel shows everyone"):
RLS write policies were read-permissive but write-blind for staff.
`using (id = auth.uid() or is staff)` already let a counsellor see
every student — that's why `admin.html` could already list everyone.
But `with check (id = auth.uid())` on those same policies meant a
counsellor could never actually *write* on behalf of anyone but
themselves. Separately, `pathways.html` had zero concept of "editing
someone else's form" — hard-wired to `auth.uid()` as the one student
it could ever represent.

**What was built**, `supabase/counsellor_managed_students.sql` +
`js/fp-app.js` + `admin.html`/`js/fp-admin.js`:

1. **Fixed the RLS write policies** on `students`, `future_pathways`
   (insert/update), and all three preference tables — added a staff
   bypass to the `with check` clause of each (previously only the
   `using` clause had one), and let staff write regardless of the
   submission's current status (needed to edit an already-submitted
   form).

2. **`counsellor_create_student()`** — a `security definer` RPC,
   staff-only (checked internally via `current_role()`, not just by
   grant). Creates a new, non-login-capable `auth.users` row (same
   shape as `load_test_seed_100_students.sql` — no `auth.identities`
   row, no real password hash, since this student is confirmed to
   never need to log in) and returns its id. Does **not** pre-create
   the `students`/`future_pathways` rows — those still come from the
   existing lazy-create logic already in `js/fp-app.js`
   (`ensureFuturePathwayRow()` / `saveProfile()`), unchanged, the same
   way they already work for a real self-service student. This RPC
   only creates the backing account those inserts require.

3. **`counsellor_reset_submission(p_future_pathway_id)`** — another
   `security definer` RPC. Implements "delete a student's form" per
   the confirmed meaning: **keep the account** (the `students` row —
   name, roll number, marks — untouched) and **clear the answers**
   (deletes all three preference tables' rows for that submission,
   clears `additional_information`, resets `status` to `'draft'` and
   `submitted_at` to `null`). Not a hard delete of anything
   identity-related.

4. **`pathways.html?student=<id>`** — `js/fp-app.js` now branches on
   this query param. Absent (the normal case): unchanged, same fast
   session-only boot path as before, no role fetch. Present: does the
   full `FP.getSessionAndProfile()` role check (only staff can
   proceed; anyone else sees a plain "this link is for
   counsellors/admins" message, backed by RLS regardless), then sets
   `state.studentId` to the URL param instead of the caller's own id
   and `state.actingAsStaff = true`. That flag: unlocks the
   Save/Transmit button and the step-advance guard even when
   `status === 'submitted'` (both previously hard-blocked past
   submission for everyone), and swaps the status banner for a
   distinct "Editing on behalf of &lt;name&gt;" one instead of the
   normal student-facing draft/submitted banners.

5. **`pathways.html`** — "+ Add new student" button lives in the
   form page's own topbar (calls `counsellor_create_student()`, then
   navigates to `pathways.html?student=<new id>`). Deliberately
   **not** on `admin.html` — an earlier version put it there, which
   meant clicking it just redirected straight back to
   `pathways.html` anyway (admin → create → land on the form page)
   for no reason; `admin.html` is view-only for the submissions list
   now. `admin.html`'s detail view still has "Edit this form" (same
   `?student=` redirect, for an existing student) and "Reset to
   draft" (calls the reset RPC, confirms first, re-renders in
   place) — those stayed, since acting on a record you're already
   looking at isn't the same "extra hop" problem as the add button
   was.

**Not built / intentionally out of scope**, since it wasn't what was
asked for: a real hard-delete of a student's account/identity (the
confirmed meaning of "delete" was reset-to-draft, not erase); any
UI for a student to log in and see their own status (confirmed they
never will); a separate "quick add" form for student info at creation
time (the RPC creates a bare account and redirects straight into the
existing multi-step form instead, which already collects that exact
information — no need to duplicate it).

## Preference-group accordion (admin detail view)

The dean wanted, per-student, a way to see each of the 4 preference
groups' 5 ranked picks (institute pathway: 4 groups; medical: 2) —
initially described as "four dropdowns" in a table, which doesn't
work (a table's job is scanning many students at once; 20 data
points per row would break that). Once clarified this was about the
*detail* page for one student, not the list, the actual ask was much
simpler: this data already existed there (`groupedRows()` in
`js/fp-admin.js`), just as always-visible flat text, not collapsible.

Replaced with `groupedAccordion()`: four independently-collapsible
sections (not tabs — more than one can be open at once, e.g.
comparing group 1 against group 3 without losing either). Used for
both Institute preferences and Faculty preferences in the detail
view (`groupedAccordion(rows, nameLookup, idPrefix)` — the
`idPrefix` param, `"inst"`/`"fac"`, keeps their panel element ids
from colliding since both call the same function on the same page).

**A real bug caught before shipping**, not just written and trusted:
the first version manually prepended `"1. "` etc. to each list item
*and* rendered them inside a native `<ol>`, which auto-numbers on its
own — result was literal "1. 1. NUST" double-numbering, confirmed via
an actual headless-Chromium render, not just reading the code. Fixed
by using `<li value="N">` instead of manual text prefixes — lets the
browser's native numbering do the work while still showing the
*real* rank number (not a re-numbered sequential count) when a
group has gaps, e.g. a partially-filled draft missing rank 3 still
correctly shows "1, 2, 4, 5", not "1, 2, 3, 4" — verified with a
render that deliberately included a gap.

## Calculate Your University Merit (`merit-calculator.html`)

Distinct from both `merit.html` (informational — shows each
institute's formula as text) and `program_closing_merits`/
`closing_merit_records` (last year's actual cutoffs) — this is a
real interactive calculator: enter your actual marks, get the exact
weighted aggregate for a specific university/program route.

```
merit-calculator.html         — the page
js/merit-calculator-data.js   — the formulas (not in Supabase —
                                 pure client-side data + arithmetic,
                                 no DB round-trip needed to compute)
js/merit-calculator.js        — controller: renders fields per
                                 selected university, validates,
                                 computes, shows the breakdown
```

Covers NUST (NET-basis), FAST-NUCES (Computing/Business AND
Engineering — two different formulas at the same university),
GIKI, PIEAS, and UET — sourced from Parhlai's and UniCalc's own
merit calculators, both explicitly named when this was requested.

**A real formula error was caught and fixed before shipping, not
guessed at:** the first fetch of Parhlai's GIKI page showed "10%
Matric + 85% Test" — which only sums to 95%, a sign of a mis-scrape,
not a real formula (a calculator that can't reach 100% is an obvious
bug). Cross-checked against ilmkidunya.com and CampusAxis
independently — both confirm 15% + 85%, with FSc/Intermediate
marks explicitly **not** weighted at all (eligibility-only, 60%
minimum). That's why GIKI's calculator only has two fields, not
three — verify this kind of thing before shipping a number, don't
assume the first source is right.

**The arithmetic was verified by actually running it**, not trusting
the code: rendered the real compute logic in headless Chromium,
manually calculated the expected result by hand for two different
universities, and confirmed the on-screen output matched exactly
(NUST: 90% SSC + 85% HSSC + 160/200 NET → 81.75%; GIKI: 92% Matric +
170/200 test → 86.05%). Also verified the validation path (empty/
out-of-range fields correctly block calculation and highlight in
red) and that `(num / maxMarks) * 100` correctly converts a "marks"-
type field (NET, GIKI's test — both scored out of 200) before
applying its weight, versus a "percent"-type field (SSC, HSSC, FAST's
test, PIEAS's percentile) which is used as entered.

**Not built / intentionally out of scope:** NUST's ACT/SAT-basis
route (same weights, but ACT/SAT use a different scale — 36 / 1600 —
that needs its own conversion, not just a different max, and wasn't
part of what was asked); O-Level/A-Level grade-to-percentage
equivalence tables (each university has its own table for this;
genuinely substantial additional research per university, out of
scope for what was requested — this version expects a percentage
input, which covers Matric/FSc board students directly and requires
O/A-Level students to convert their own grades first); universities
beyond the five named when this was requested.

**Revised after initial feedback:**
1. Matric/SSC and FSc/HSSC are now entered as obtained + total marks
   (`type: "marks_variable"` in `merit-calculator-data.js`), not a
   direct percentage — the tool computes the percentage itself.
   Only fields that are already a percentage with no natural "out of"
   total (a test percentage, PIEAS's percentile) still take a direct
   percent input.
2. The result no longer shows a per-component breakdown — just the
   final aggregate, plus a link to University Explorer to compare
   against last year's closing merit.
3. **The "SOURCE: Parhlai / UniCalc" line was removed from the
   calculator UI entirely.** `sourceUrl`/`sourceLabel` still exist in
   `merit-calculator-data.js` — kept for internal maintainability, so
   a future update knows where a formula came from — but nothing
   reads them for display anymore.

## Important: don't cite sources where they're not load-bearing

Direct instruction, worth keeping in mind for anything built after
this: **citing an external site on a page where the citation isn't
actually doing work for the reader makes the product look cheap** —
like a thin wrapper around someone else's tool, not something built
with its own credibility. This is why the merit calculator shows no
"powered by" or "source:" line, even though its formulas originated
from Parhlai/UniCalc.

The distinction that matters: cite where the citation is *load-
bearing* — the Merit & Entry Test Guide and University Explorer
pages, where a `confidence` rating and a source link are the whole
point (the reader needs to judge how much to trust a number). Don't
cite on a tool where the person is entering *their own* data and
getting *their own* result — the source of the formula isn't
what they came for, and naming it there just reads as borrowing
someone else's credibility instead of standing on the product's own.
Applies to future pages too, not just this one — check which kind of
page something is before deciding whether a source line belongs on
it.

## Interaction design pass

Applied the `interaction-design` skill's principles (purposeful
motion, transform/opacity-only for perf, consistent timing scale,
`prefers-reduced-motion` respected) — translated into vanilla CSS/JS
since this app has no React/Framer Motion and the skill's own
examples assume both.

1. **Timing/easing tokens** in `base.css` —
   `--dur-micro/small/medium` (120/220/320ms) and
   `--ease-out/in-out/spring`. Every transition added below pulls
   from these instead of ad-hoc per-rule values; use them for
   anything added later too, don't reintroduce hardcoded durations.
2. **Buttons** — real press feedback (`scale(.98)` on `:active`) and
   hover lift. Applied to both `.btn-primary` definitions — yes,
   there are two (`components.css` and `pathways.css`, pre-existing
   duplication, not consolidated here, out of scope) — kept
   identical so the feel doesn't differ between pages.
3. **Dashboard tool cards** — hover now lifts (`translateY(-3px)` +
   shadow) instead of just swapping colors. **Caught a real bug
   while testing this**: hovering a card underlined its text,
   inherited from a global `a:hover{text-decoration:underline}` rule
   the card never overrode for its own hover state. Fixed
   (`.dash-tool-card:hover{ text-decoration:none; }`) and confirmed
   gone via render — worth knowing this pattern can bite any other
   `<a>`-as-card component added later.
4. **Accordion** (admin detail view preference groups) — was an
   instant `hidden`-attribute toggle, zero transition possible
   (`display` can't be animated). Replaced with the CSS Grid
   `grid-template-rows: 0fr → 1fr` technique — animates truly
   auto-height content without JS measuring it first. Required a
   markup change (`fp-accordion-panel` is now wrapped in
   `fp-accordion-panel-wrapper`, which is the grid; toggling adds/
   removes an `.is-open` class instead of the `hidden` attribute) in
   both `js/fp-admin.js` (markup generation) and the click handler.
5. **Modal entrance/exit** (the "View all universities" modal, two
   separate implementations in `js/dashboard.js` and `js/fp-app.js`)
   — was an instant `hidden` toggle. Now fades + scales in/out.
   Needed real JS choreography, not just CSS: on open, clear
   `hidden` → force a reflow (`void overlay.offsetWidth`) → add
   `.is-open` (skipping the reflow means the browser coalesces the
   attribute change and the class addition into one paint and the
   transition never plays). On close, remove `.is-open` first, then
   `setTimeout` the `hidden = true` re-application to match
   `--dur-medium` — otherwise `hidden` would cut the exit animation
   off instantly. The `setTimeout` callback checks
   `!classList.contains("is-open")` before hiding, guarding against
   a rapid close-then-reopen leaving the modal incorrectly hidden.
6. **Merit calculator result reveal** — new shared `.reveal-in`
   keyframe (`base.css`: fade + `translateY(8px)→0`), applied to the
   result card when it appears after clicking Calculate. Reusable
   for any future "this just happened" moment (a save confirmation,
   etc), not calculator-specific.

**Verified every one of these by actually rendering it in headless
Chromium**, not by reading the CSS and assuming it's right — same
discipline as the rest of this project. Specifically: card hover
screenshotted before/after the underline fix; accordion screenshotted
with both groups open independently; modal screenshotted at rest,
mid-open, fully open, mid-close, and fully closed (confirming
`overlay.hidden` actually re-applies after the close animation, not
just that the CSS looks plausible); calculator result screenshotted
early-in-animation and settled, with the underlying math re-verified
correct (GIKI: 990/1100 Matric + 170/200 test → 85.75%).

## shadcn/ui-inspired tokens (not the framework — vanilla CSS only)

Explicit decision: adopt shadcn/ui's *structural* CSS conventions,
not the framework itself. shadcn/ui is React + Tailwind + a CLI that
copies component source into a project — fundamentally incompatible
with this app's deliberate no-build-step vanilla HTML/CSS/JS
architecture. Cloning `github.com/shadcn-ui/ui.git` (done once, to
`/tmp` for reference, not committed) doesn't "install" anything
usable here; it's their own docs-site monorepo. What was actually
useful from it: their real default `apps/v4/app/globals.css` theme
tokens, read directly rather than trusted from memory.

Two things ported into `styles/base.css` / `styles/components.css`:

1. **Proportional radius scale** — `--radius-md/lg/xl/2xl`, each
   derived from `--radius` via `calc()` (shadcn's actual approach),
   instead of independently-picked values. `--radius`/`--radius-sm`
   unchanged, so nothing already using them shifted.
2. **Soft focus ring** replacing the old hard 2px outline — shadcn's
   `ring` + `border-color` pattern, ported to `var(--violet)`.

**This one feature surfaced two real, verified cascade bugs** — both
fixed, not just described:

- The global `:focus-visible` ring first used `box-shadow`. Every
  `.btn-primary` has its own `box-shadow` (its glow effect) at equal
  CSS specificity — depending on stylesheet load order, the button's
  own shadow silently won and the focus ring never appeared at all
  on buttons. Confirmed via render (no ring visible), fixed by
  switching to `outline` for the *global* rule specifically, since
  `outline` is a separate property that can't collide with any
  component's `box-shadow`, present or future.
- A **pre-existing, more specific** `input:focus` rule (higher
  specificity than the global fix, so it kept winning for every form
  field) had the same class of problem independently: it used
  `:focus` (fires on mouse clicks too, not just keyboard) and
  `var(--violet-dim)` (14% opacity — tuned for subtle background
  fills, not an accessibility-grade focus indicator) for its own
  ring. Renamed to `:focus-visible`, strengthened the ring opacity to
  match the global one, and added `!important` to that specific
  ring's `box-shadow` after confirming empirically (via
  `getComputedStyle`, not just a screenshot) that it was still being
  overridden without it. If a focus ring on some new form-adjacent
  component ever looks wrong again, check for exactly this pattern
  first — a component's own `box-shadow` at equal specificity is the
  single most likely cause, given it's now happened twice.

Verified across both themes, both interaction modes (keyboard Tab
and mouse click), on input/button/link, via direct computed-style
inspection (`getComputedStyle`) as well as screenshots — the
screenshot-only check on this specific feature had already been
fooled twice by rules that looked right but weren't winning the
cascade.

## Dashboard stats strip — "fill the gap"

Came out of looking at lawnline.marketing (an actual client's site,
fetched directly, not worked from description) for design inspiration.
Most of that page's patterns (pricing tiers, case studies, testimonial
carousels, conference-logo credibility) don't transfer — it's a public
ad-funnel landing page for a B2B agency converting cold traffic, and
this product has no such funnel; it's an internal tool for one
college's counsellors. But one thing does transfer directly: the hard-
numbers KPI strip right under their hero ($25M+ deployed, 425+
businesses scaled, etc). The lesson isn't "add a stats strip" as
decoration — it's that this product already has real substance (84
sourced merit formulas, ~30 institutes, 99 closing-merit records) and
none of it was visible anywhere in the product itself. The gap wasn't
a missing feature, it was invisible existing substance.

Added a stats strip to `index.html`'s dashboard, between the status
card and the tool grid: institutes tracked, merit formulas sourced,
closing merit records — all real counts, all read from data already
being fetched for other purposes on this page
(`Counsellor.INSTITUTES`, `FP.MERIT_FORMULAS`, `FP.CLOSING_MERIT` —
`.length` on each, zero extra network round-trips). A fourth stat,
students helped (submitted `future_pathways` count), is added
separately once role is known and **only shown to staff** — a plain
student's RLS-scoped view of `future_pathways` only covers their own
row, so counting it as a non-staff user would render a misleadingly
small number instead of the real total, which would be worse than
not showing it. Reuses the existing `.fp-stat`/`.fp-stat-value`/
`.fp-stat-label` component (already used by `admin.html`'s own stats
strip) rather than inventing a new pattern — new CSS is just the
`.dash-stats` wrapper (hairline dividers via a 1px background-color
gap trick, wraps to 2×2 on mobile).

Verified via render: real counts at desktop width, light theme, and
the mobile 2×2 wrap — all clean, dividers intact.

**Bug found live, fixed same day:** the strip shipped showing literal
"undefined" for institutes/merit-formulas/closing-merit (students
helped rendered fine, since it's an independent query). Root cause:
`meritPromise.catch(...)` / `closingMeritPromise.catch(...)` were
attached right after creation for error logging — but `.catch()`
creates a *new*, separate derived promise; it does not change
whether the *original* `meritPromise`/`closingMeritPromise`
references (the ones actually passed into `Promise.all([...])`
further down) end up rejected. If either genuinely rejected for any
reason, `Promise.all` rejected as a whole and its `.then()` — the
entire render — silently never ran. `el.dataset.counts` was then
never set, so the later staff-only "students helped" render read an
empty `{}` and merged in just that one stat, producing exactly the
observed pattern.

Fixed by converting each promise to always-resolve (`.catch(() =>
null)`) *before* handing it to `Promise.all`, so one failed load can
no longer take the whole strip down — and the render function itself
now filters to only ever show a stat backed by a real finite number,
so even a genuine failure renders as "one fewer stat," never
"undefined" text. Verified by actually simulating the failure (one
promise rejecting, mirroring exactly what must have happened live)
in both a standalone Node script and a real browser render — not
just reasoned about after the fact.

## Stats strip refinements — three ideas picked from a brainstorm

Came out of asking "suggest more ideas like the stats strip" —
researched real, current dashboard-design sources first (not just
brainstormed from memory) before proposing anything, then checked
what the app's own data actually supports before promising any of
it. Three were picked and built:

1. **"Closing merit records" now excludes `source_type = 'not_found'`
   rows.** This was a real, already-live inaccuracy, not a
   hypothetical: of the 99 rows in `closing_merit_records`, 17 are
   internal placeholders marking "looked for this, couldn't confirm
   it" — not real data points. The stats strip was counting all 99,
   overstating actual verified coverage by 17. Now counts only
   `official`/`third_party` rows (82, as of this data). Same honesty
   principle as everywhere else in this project (the GIKI formula
   correction, "don't cite sources that aren't load-bearing") — a
   confidence number that quietly counts its own gaps as wins isn't
   trustworthy.
2. **Freshness line** under the stats strip: "Closing merit data
   current as of the [year] admission cycle." Computed from
   `MAX(closing_merit_records.admission_year)` — a clean `int`
   column, used deliberately instead of `merit_formulas.effective_year`
   (free text — `'2025-26'`, `'2025-26/current'`, `'Current'` — not
   reliably sortable, would have needed fragile string parsing to get
   a real "most recent" out of it).
3. **Empty state for the students-helped card.** A brand-new
   counsellor account with zero students added previously just saw a
   bare "0" in that slot — reads as broken, not as an invitation.
   Now, specifically when the count is exactly `0`, that card becomes
   a violet "+ Add / First student →" link straight into
   `pathways.html`'s "Add new student" flow, same visual slot and
   weight as the other three cards.

Verified all three via render: real numbers with the freshness line,
the empty-state CTA at rest and on hover, and light theme — plus a
direct assertion (via `page.evaluate`) that the not_found exclusion
actually produces 82 from a simulated 99-row set with 17 not_found
rows mixed in, not just "the screenshot looks right."

## Cursor-tracking grid glow on the 4 dashboard tool cards

Requested as "the glowing net that follows the cursor" from
lawnline.marketing — **could not actually load that site to inspect
it**: this sandbox's network access is a small allowlist (npm/GitHub/
package registries), lawnline.marketing isn't on it, and `web_fetch`
only extracts static text content regardless — it can't show a live
cursor-tracking hover effect either way. Built from direct knowledge
of the pattern instead (a well-established one, sometimes called a
"spotlight card": a faint background grid + a soft radial reveal that
follows the cursor), not from having seen their exact implementation.
Worth knowing if it doesn't match what was seen in the podcast exactly.

Applied to the 4 `.dash-tool-card` elements specifically (confirmed
via a clarifying question — the screenshot given was actually one of
lawnline's *program tier* cards, icon+title+description+CTA, which
structurally matches these tool cards, not the flatter stats strip).

Mechanics: `.dash-tool-card::before` holds a faint grid pattern
(`linear-gradient` cross-hatch, violet at low opacity), masked by
`mask-image: radial-gradient(circle 110px at var(--mx,50%)
var(--my,50%), black 0%, transparent 100%)` — invisible everywhere
except a 110px circle around the cursor. `--mx`/`--my` are plain CSS
custom properties in px, relative to each card's own top-left corner
(not the viewport), set by a `mousemove` listener in
`initToolCardGlow()` (`js/dashboard.js`) — purely decorative, no
auth/data dependency, wired up immediately alongside `initUniModal()`.
Real card content gets an explicit `.dash-tool-card > *{ z-index:1 }`
so it's never ambiguous whether it renders above the glow layer.

Verified by actually moving a simulated cursor via Playwright
(`page.mouse.move`, not just CSS reasoning) to two different corners
of the same card and confirming the glow's position moved with it,
confirmed clean per-card isolation (moving off one card onto an
adjacent one correctly transfers the glow, no stuck/leftover state),
and checked both themes.

## Crimson glow variant + fixed a real lag bug + a real specificity bug

Extended the cursor-glow effect to two more places, plus fixed a
reported performance issue in the original.

**Lag fix (root cause, not a guess):** the original `mousemove`
handler called `style.setProperty()` synchronously on every raw
event. `mask-image` recalculation is comparatively expensive
(unlike a `transform` change, which is cheap/GPU-composited) --
on a fast mouse, events can fire faster than the browser can
actually repaint, and each of those extra `setProperty()` calls
queues up real work, so the glow visibly trails the cursor instead
of tracking it live. Fixed by collapsing all mousemove events into
at most one `requestAnimationFrame`-scheduled style update per
frame (`initCursorGlow()`, replacing the old `initToolCardGlow()`,
now shared across all three uses instead of copy-pasted).
**Proved the fix, not just described it:** dispatched 50 synthetic
mousemove events synchronously (simulating a fast mouse in a single
frame) and counted actual `style.setProperty()` calls via a wrapped
spy -- 50 events collapsed to 2 real writes (one rAF-scheduled
update, `--mx` + `--my`), versus the ~100 the old code would have
made for the same input.

**New locations, both crimson, not the app's semantic `--red`:**
the "Recently saved forms" panel (applied to the whole `.fp-card`
wrapping the table, not per-`<tr>` -- table rows handle absolutely-
positioned pseudo-elements poorly, and a table is a scan-down list,
not a grid of discrete cards, so a per-row glow wouldn't have made
visual sense anyway) and the KPI stats strip (`.dash-stats .fp-stat`,
re-wired via `initCursorGlow()` after every render since
`innerHTML` replacement destroys the previous elements' listeners
along with them -- this strip re-renders twice, once for public
data and again when the staff-only students-helped count arrives).
Deliberately not reusing `var(--red)` for the color -- that token
means "error" everywhere else in this app; a purely decorative
glow shouldn't borrow the same signal.

**Second real bug, caught before it shipped wrong:** the first
crimson attempt used a bare `.glow-red::before` selector, which is
LOWER CSS specificity (one class) than `.dash-stats .fp-stat::before`
(two classes) -- so on the KPI strip specifically, the shared violet
default silently won regardless of source order, and the "crimson"
cards rendered violet. Same class of cascade bug already hit twice
before with the focus-ring work (see above) -- confirmed via
`getComputedStyle` (not a screenshot) that `--glow-line-color` was
resolving to the violet default, then fixed by writing the override
selectors to match each shared-mechanics selector's specificity
exactly (`.dash-tool-card.glow-red::before`,
`.fp-dash-glow.glow-red::before`, `.dash-stats
.fp-stat.glow-red::before`) instead of hoping a single lower-
specificity rule would win on order alone. Re-confirmed via
`getComputedStyle` that the override now resolves correctly before
calling it done.

**Also worth being honest about:** none of this was built by
actually inspecting lawnline.marketing's real effect -- this
sandbox can't reach that site (small network allowlist), and even
`web_fetch` only pulls static text, not a live interactive render.
Built from direct knowledge of the general pattern instead.

## Background replaced + original isometric "FIG" illustrations

Direct feedback: the aurora glow background (soft blurred violet
blobs, animated) read as generic "AI-generated SaaS" — a fair
critique regardless of how carefully it was tuned (color-banding
fixes, noise dither, etc. from earlier work) — soft glowing gradient
blobs are simply an overused trope at this point.

**Background**: replaced entirely with a static technical grid
(`body::before` in `base.css`) — fine 24px lines plus a bolder line
every 4th cell (96px), like real graph paper. No blur, no animation,
no noise layer (hard-edged 1px lines don't have the gradient
color-banding problem the noise dither existed to fix, so that whole
layer is gone too — genuinely simpler than what it replaced, not
just different). `--aurora-*` tokens removed entirely, replaced with
`--grid-line`/`--grid-line-strong`, both themes.

**Illustrations**: reference images shown were a purchased/AI-
generated stock illustration set (thin monochrome isometric line art,
"FIG 0.X" patent-diagram labeling) of unknown license — didn't just
reuse the JPG. Instead built three *original* SVG illustrations in
the same visual language, tied to real product concepts instead of
generic geometry:
- FIG 01 — stacked layers = ranked preference groups (4 groups × 5
  choices)
- FIG 02 — clustered cubes = tracked institutes
- FIG 03 — fanned panels = verified merit/closing-merit records

Coordinates computed precisely via a small Python script (proper
isometric projection math — top diamond + two side parallelograms
per cube, consistent 30°-equivalent angles), not eyeballed. Colored
with the site's own theme tokens (`var(--surface-2)`, `var(--violet-
dim)` for one accent face per figure) so they correctly adapt to
both themes automatically — verified via render in both, including
catching and ruling out a timing artifact in my own test harness
(the first light-theme screenshot looked broken — body/card
background hadn't visually settled yet because I only waited 200ms
against a 220ms CSS transition; re-tested with an 800ms wait and
confirmed via `getComputedStyle` that theme switching was actually
correct all along).

Placed on `login.html` specifically — the closest thing this
product has to a public "first impression," since everything else
sits behind the login wall. Login form stays narrow/centered as the
primary action; the three figures sit below as a real explanatory
strip, not decoration bolted onto an unrelated page.

Also verified the new background composes cleanly with everything
built earlier in this session (crimson glow KPI cards, tool cards) —
solid card backgrounds sit correctly above the grid with no visual
conflicts.

## Isometric FIG illustrations moved: login.html → index.html

Real usability problem with the original placement, not just a
preference change: `login.html` redirects away immediately if the
browser already has a session (`FP.getSessionAndProfile()` check at
the top of the page) — so a returning, already-logged-in user (the
normal case after the first visit) never sees that page again at
all. Putting the one place with real "look how substantial this is"
content on a page most usage skips past entirely defeated the point.

Moved the three figures (unchanged content/geometry) to `index.html`
— the dashboard, which gets seen every session. Placed at the very
bottom, after "Recently saved forms", behind a `border-top` divider,
deliberately below all actionable content (stats, tools, saved
forms table) rather than competing with it for attention.

Renamed the CSS classes from `.login-fig*` to `.dash-fig*` while
moving them (`.login-figs` → `.dash-figs`, etc.) — they're not
login-specific anymore, and leaving the old name would have been
confusing for anyone reading the CSS later. Verified no leftover
`login-fig` references anywhere in the codebase after the rename.
`login.html` is back to just the sign-in form.

## Dashboard margin figures — 3 more, scroll normally with the page

Direct feedback: on a wide screen, the centered 780px content column
leaves real dead space in the left/right margins. Expanded the
isometric illustrations from 3 to 6 (the original 3 concepts + 3
new ones tied to other real features: calculate-your-merit as
ascending bars, University Explorer as a varied-height cluster, the
counsellor-managed workflow as 3 connected nodes) and moved them
into those margins instead of one bottom-clustered section.

**Layout mechanics** — this is the first time anything on the site
breaks out of the single centered `.wrap` pattern used everywhere
else, so worth documenting precisely: `index.html`'s `<main>` is now
a flex row (`.dash-main-wide`) with three children — a 170px-wide
margin column on each side (`.dash-margin-col`, `display:flex;
flex-direction:column; justify-content:space-between`) and the
actual dashboard content in the middle (`.dash-main-content`, still
`.wrap`-based, `flex:0 1 780px`). The margin columns use
`align-items:stretch` (inherited from the parent) to match the
content column's actual height, then `justify-content:space-between`
+ a `gap:40px` floor distributes each column's 3 figures evenly
across whatever that height turns out to be — no fixed pixel offsets,
no JS measurement, correct regardless of how many rows are in the
"Recently saved forms" table. Verified this specifically: an early
test render with unrealistically short content (no stats populated)
showed the figures crowding together, which could have been mistaken
for a real bug — re-tested with realistic mock content (populated
stats, table rows) and confirmed proper spacing; the `gap` floor
stays as a safety net regardless.

**Also verified**: had to explicitly override `.dash-main-content`'s
inherited `margin:0 auto` (from `.wrap`) to `margin:0` — auto-margins
on a flex item behave very differently than in a normal block
context and could have fought with the side columns' fixed widths;
caught and fixed before testing, not discovered as a rendering bug.

Below `max-width:1240px` the margin columns disable entirely
(`display:none`) rather than trying to fit — the figures are
decorative, not essential, so on narrower screens (where there's no
room for 170px margins either side of a 780px column) they simply
don't render, and the main content re-centers normally. Verified
this fallback renders cleanly, no squeezing. Confirmed in both
themes.

## Four fixes: wider layout, admin quick actions, rename, modal cleanup

1. **Widened dashboard layout.** `.dash-main-wide` no longer caps at
   1400px — figures now sit at the true viewport edges via
   `justify-content: space-between`, and the main content column
   grew from 780px to 960px, so the KPI/tool cards read as
   noticeably larger, not just "more space around the same cards".
   Breakpoint recalculated (1240px → 1420px) to match. **Known,
   accepted inconsistency**: the header above still uses the
   standard 780px `.wrap` (same as every other page, for
   consistency), so it doesn't line up with the wider content below
   it on very wide screens — flagged, not silently fixed, since
   widening the header wasn't asked for and might not be wanted.

2. **Admin table inline Edit/Delete.** New Actions column per row —
   "Edit" (links straight to `pathways.html?student=<id>`) and
   "Delete" (the existing reset-to-draft RPC, same confirmed
   meaning as before: keeps the account, clears the answers).
   Refactored the reset logic into one shared `resetSubmission()`
   function used by both the table row and the pre-existing
   detail-view button, instead of duplicating the confirm-copy/RPC-
   call/error-handling. Caught and fixed a bug introduced during
   that refactor (a duplicated row-click event listener) before it
   shipped. Verified the click-vs-row-click interaction directly —
   clicking Edit or Delete does NOT also trigger the row's own
   "open detail" handler, clicking elsewhere in the row still does.

3. **Brand tagline**: "university counsellor" → "NORTHLINE
   university counsellor" on `index.html` and `login.html` only —
   the other pages have their own contextual tags (e.g. "merit
   calculator") that were correctly left alone. Verified no overflow
   at 1400/900/500px viewport widths.

4. **University modal cleanup**, two separate copies
   (`dashboard.js` for `index.html`, `fp-app.js` for
   `pathways.html`) each had their own bugs:
   - `dashboard.js` had three buttons per institute row ("View
     merit formula", "View programs", "View 2025 closing merit").
     Removed the first two (redundant with the dedicated Merit
     Guide page, and unused respectively), kept the closing-merit
     one as the single remaining action — it's the more concrete,
     less-duplicated piece of information.
   - **Found and fixed a real pre-existing bug while in there**: the
     closing-merit button carried both `merit-toggle` and
     `closing-merit-toggle` classes, and the `merit-toggle` handler
     ran first with an early `return` — meaning it was silently
     swallowing clicks meant for the closing-merit toggle before
     ever reaching the correct handler. Removing "View merit
     formula" naturally fixed this, but the button's class list was
     also cleaned up (dropped the now-pointless `merit-toggle`
     duplicate) rather than leaving a dead collision risk in place.
   - `fp-app.js` never had a closing-merit alternative to begin with
     (only "View merit formula" + "View programs") — removed only
     "View programs" there; "View merit formula" stayed, since
     there was no duplicate to justify removing it in that copy.

All four verified via actual render/interaction test (Playwright),
not just read back from the diff — including a direct click-sequence
test proving Edit/Delete/row-click each fire exactly the right
handler and nothing else.

## Admin panel: add-student + name search, and a merit-toggle correction

**Correction, not a new decision**: the last session's choice on
`index.html`'s university modal (keep "View 2025 closing merit",
drop "View merit formula") was wrong — direct feedback was to keep
the formula and drop the closing-merit one instead. Swapped back:
`dashboard.js` now has only `merit-toggle` (same as `fp-app.js`
already did), `closing-merit-toggle` and its container are gone
entirely. Both copies are now consistent with each other.

**`admin.html` gets its own "+ Add new student"**, in addition to
the one already on `pathways.html` (not instead of — both stay).
Same proven RPC-then-redirect pattern already working there:
`counsellor_create_student()`, then `pathways.html?student=<id>` --
actual data entry always happens on the form page regardless of
where you started, this just saves a trip through the list view
first if that's where you already are.

**Search by name**, live-filtered (fires on `input`, not requiring
Enter), case-insensitive substring match against `student_name`,
combined with the existing pathway/status/first-priority filters
(all four apply together, same `renderTable()` pass). Verified the
actual filtering logic directly, not just the UI: multi-match single-
match, clearing back to all results, and case-insensitivity
(uppercase query against a lowercase name and vice versa) all
confirmed correct via real interaction, not just visual inspection.

## Nav pills: full pill → matching button radius, site-wide

`.nav-link` (every topbar button on every page — "View all
universities", "NORTHLINE form", "Log out", etc.) used
`border-radius: 999px` — a full pill, a different shape from every
other button on the site (`.btn-primary`/`.btn-secondary` both use
`--radius-sm`). Direct feedback: this specific button read as
generic/templated. The actual fix isn't a color or font tweak, it's
shape consistency — `.nav-link` now uses the same `--radius-sm` as
the rest of the button vocabulary, so there's one consistent
"button" shape language across the site instead of pills as an
outlier.

Also added the same hover-lift treatment already established
elsewhere (buttons, cards) — `translateY(-1px)` + a subtle shadow on
hover — and switched the transition timing from hardcoded values to
the shared `--dur-micro`/`--ease-out` tokens, matching everything
else. One shared class, so this updates every page's topbar at
once. Deliberately left `.fp-badge` (status tags) pill-shaped — that
serves a different purpose (a tag/chip, not a clickable button) and
shape-differentiating "clickable" from "label" is useful, not
something to homogenize away.

Verified via render: rest state next to `.btn-primary`/
`.btn-secondary` for a direct shape comparison, hover state, and
both themes.

**Follow-up correction**: `.theme-toggle` is a separate CSS class
from `.nav-link` (its own rule block, own hover/active states) and
was missed in the pass above — still a full pill. Fixed the same
way: `border-radius: 999px` → `var(--radius-sm)`, added the same
hover-lift, switched to the shared timing tokens. Also audited every
other remaining `border-radius: 999px` in the codebase (6 more:
`.badge`, `.dash-status-tag`, `.merit-institute-pathway-tag`,
`.merit-conf-badge`, `.cm-badge`, `.rk-tag`) to make sure nothing
else got missed — confirmed all six are genuinely tags/labels, not
clickable buttons, and correctly stay pill-shaped. `.theme-toggle-
glyph` (the small circular day/night indicator inside the button)
also correctly stays round — that's a deliberate, meaningful shape,
not an arbitrary pill.

## Light theme: measured the "mixing into background" complaint, it was real

Two complaints, same root cause: the isometric FIG diagrams almost
invisible against the light-theme background, and the light theme
overall reading as "totally white, no other color, hard to
navigate." **Computed actual WCAG relative-luminance contrast
ratios before touching anything**, rather than just eyeballing it —
`--canvas` vs the diagram faces (which reused `--surface`/
`--surface-2`) sat at 1.07-1.08:1. Under ~1.15:1 is essentially
imperceptible without a border doing all the work — "mixing into
the background" was a literal, measurable description, not just a
feeling. `--canvas` vs `--surface-2` generally (page background vs.
input fields, hover states) sat at only 1.07:1 too, explaining the
"totally white" complaint — there wasn't enough tonal separation
between page/card/input for anything to read as distinct.

**Fix, verified with the same math before shipping**:
1. Widened `--canvas`/`--surface`/`--surface-2` separation and gave
   `--canvas` a visibly violet tint instead of near-neutral white
   (`#F6F6FA` → `#EAE9F5`, `--surface-2` `#EEEEF4` → `#DFDCEF`) —
   addresses "no other color" directly, not just the contrast math.
2. New dedicated tokens for the isometric figure faces
   (`--iso-top`/`--iso-left`/`--iso-right`) instead of reusing
   `--surface`/`--surface-2` — **dark theme's tokens default to the
   exact previous values** (`var(--surface-2)`/`var(--surface)` +
   the same opacity), so dark mode is provably unchanged; light
   theme gets dedicated solid colors with a real light-to-dark
   gradient across the three faces (1.22:1 / 1.55:1 / 1.99:1 against
   canvas) — both fixes the contrast problem and reads as more
   three-dimensional than the flat opacity-blend dark mode uses.

Verified via render, not just the math: the actual FIG 01 SVG in
light mode (clearly visible now, real violet color, believable
shading) side by side with dark mode confirmed pixel-identical to
before, plus a general UI render (stats strip, card, input field) in
light mode showing every surface now clearly distinguishable from
the ones around it.

## Merit calculator: 3 more universities, each cross-verified before adding

Asked which universities' formulas I was confident enough in to add.
Answered honestly first — no web-research claim is truly 100%
certain, no official page was directly the source for any of these,
only third-party aggregators — then gave a confidence tier based on
how many independent sources agreed, same standard already used for
the GIKI correction earlier in this project.

**COMSATS** — 10% Matric + 40% Intermediate + 50% NTS/NAT. 9
independent sources, all in agreement, one referencing COMSATS's own
admissions portal directly.

**NED University (Karachi)** — 40% FSc + 60% Entry Test, **no Matric
at all**. 5 independent sources, all consistent on this genuinely
unusual detail (NED is the only major Pakistani engineering
university that drops Matric entirely) — confirmed by *not* giving
NED a Matric field, and adding an explicit note so it doesn't read
as a bug.

**Punjab Medical Colleges (MDCAT-based, MBBS/BDS)** — 10% Matric +
40% FSc + 50% MDCAT (MDCAT fixed at 180 marks). Started at "one
source, medium confidence" — went back and searched specifically to
either raise or drop that confidence rather than shipping on a single
source. Found 10 more independent sources, several explicitly citing
PMDC/UHS as the governing bodies, upgrading it to high confidence.
This is a standardized *provincial* formula, not one specific
university's rule (framed that way in the notes field, and flagged
that NUMS uses a different formula entirely, not covered).

All three added using the exact existing patterns — `marks_variable`
for Matric/Intermediate (obtained + total, since totals vary by
board), `marks_fixed` for MDCAT (180, fixed and universal),
`percent` for NTS/NED-test (already percentage, no fixed total
found). No new field types, no new UI patterns, no source line shown
in the app (per the earlier "don't cite where it's not load-bearing"
principle) — `sourceUrl`/`sourceLabel` kept in the data file only,
for internal maintainability.

**Verified by actually running the math**, not just adding data and
trusting it: computed each by hand (COMSATS 90/85/78 → 82.00%; NED
88/82 → 84.40%; Punjab Medical 90.9/91.8/83.3 → 87.48%) and confirmed
the live calculator produced the exact same numbers. Also confirmed
NED's form genuinely has no Matric input field at all (not just
hidden/disabled) — the calculator only asks for what the real
formula actually uses.

## Three admin fixes: white search box, native confirm(), bulk delete

**White search input** — `input[type="search"]` was missing from the
base input styling selector list (`input[type="text"],
input[type="number"]...` etc.), so every `type="search"` field in
the app (4 of them: admin's name search, the "View all universities"
search on two pages, merit.html's institute search) fell back to
raw browser default styling — a plain white box, matching the exact
bug shown. Fixed by adding the missing selector, plus
`appearance: none` (WebKit/Safari specifically retain native search-
input chrome — rounded corners, clear button — even after custom
background/border CSS is applied, unless explicitly reset).

**Native `window.confirm()` dialog** — the browser's own popup,
showing the raw hostname, completely unstyled, ignoring the app's
theme. New `js/fp-confirm.js`: `FP.confirm(message) -> Promise<boolean>`,
reusing the exact fade/scale overlay choreography already proven for
the "View all universities" modal (force a reflow before adding
`.is-open` so the transition plays, delay re-applying `hidden` on
close to match the transition duration) rather than inventing new
mechanics. Verified all three resolution paths directly (OK, Cancel,
Escape key) via real click/keypress interaction, not just visual
inspection. Only one `window.confirm()` existed in the whole
codebase (`resetSubmission()`) — now the only place needing it.

**No bulk select/delete** — added a checkbox column (header
"select all" + one per row) and a bulk-actions bar that appears when
1+ rows are selected, showing the count and the affected students'
names in the confirm dialog (so "Delete selected" doesn't read as a
black box). Required refactoring `resetSubmission()`: split the
confirm step from the actual RPC call (`performReset()`) so a bulk
action shows **one** confirm covering the whole batch instead of one
per student — the original function conflated "ask" and "do", which
would've meant N confirm dialogs for N selected students otherwise.
**Caught a real selector collision before it shipped**: the bulk
button and the per-row buttons share a CSS class
(`.fp-row-action-delete`) for consistent styling, but a bare
`document.querySelectorAll(".fp-row-action-delete")` would have
wired the per-row click handler (which expects `data-reset-id`) onto
the bulk button too — scoped the row-button query to
`#fp-admin-tbody .fp-row-action-delete` specifically to avoid it.

Verified via actual interaction testing, not just visual checks:
select-all correctly checks every visible row, individual selection
correctly updates the bulk bar's count, and the bulk confirm dialog
correctly lists the real selected students' names before the RPC
calls ever fire.

## Bulk-delete "where's the button" — a real positioning flaw, not a bug

Traced through the bulk-select code carefully first (fresh clone,
line-by-line read, re-ran the exact interaction tests from the
previous session against the current pushed state, checked for
console errors) — the underlying logic was correct, no regression.
But re-reading `admin.html`'s actual layout order surfaced a real,
independent problem regardless: the bulk-actions bar sat *above all
four filter fields* (search, pathway, status, first-priority),
several elements away from the table where someone's actually
looking when they check a box. Functioning correctly and being
*findable* aren't the same thing — worth remembering that "I built
it and it works in my test" doesn't mean "a person will actually see
it," especially several actual scroll-lengths of unrelated filter UI
away.

Fixed by moving `#fp-bulk-actions` to sit directly above the table,
after the filters — the closest it can be to where the interaction
that reveals it just happened. Also added the `.reveal-in` animation
(already established elsewhere in the app for "this just appeared"
moments) specifically on the transition from hidden → visible, as
extra insurance beyond repositioning alone.

**Separately**: removed the "e.g. Ahmed Khan" placeholder from the
name-search field — replaced with a generic "Type a name…" that
doesn't reference any name at all. Checked the rest of the codebase
for the same pattern (any other placeholder using an example
person's name) — found none.

Verified via render: the bar now appears immediately adjacent to the
checkbox that revealed it, not scrolled away above unrelated
filters, confirmed the reveal-in animation triggers correctly on the
hidden→visible transition specifically (not on every re-render while
already visible), and confirmed the placeholder text renders as a
real ellipsis character, not a literal escape sequence (the same
class of bug caught multiple times earlier in this project).

## Checkbox click target: tiny, and near-misses opened the wrong thing

Direct feedback: the row-select checkboxes were too small to click
reliably, and missed clicks were landing on something else entirely
(specifically: opening that student's detail view instead of
selecting them). Traced the actual cause rather than just enlarging
the checkbox and hoping — the row's click handler guarded against
`.fp-row-select` (the checkbox element itself, ~14px), not the space
around it. A click that missed the checkbox by even a couple of
pixels landed on the surrounding `<td>`, which the guard didn't
recognize, so it fell through to `openDetail()`. That's the exact
mechanism behind "I go somewhere else."

Two-part fix: the checkbox is now wrapped in a `<label>` that fills
the *entire* cell (native HTML behavior — clicking anywhere in a
label toggles its checkbox, not just the input itself), sized up to
roughly 59×53px of clickable area with the checkbox itself enlarged
to 20px and given the site's violet accent color instead of the
unstyled browser default. The row-click guard was updated to match
against `.fp-select-td` (the whole cell) instead of `.fp-row-select`
(the checkbox alone), so the fallthrough-to-detail-view bug is fixed
at its actual source, not just made less likely by a bigger target.

Verified with a real precision test, not just a screenshot: clicked
5px from the corner of the cell — deliberately nowhere near the
checkbox's own bounds — and confirmed it still toggled the checkbox
correctly and did *not* open the detail view, compared directly
against a dead-center click for the same result.

## Real delete, separate from "Clear data" — needs a SQL migration run manually

Direct feedback: "Delete" never actually deleted anything — it only
ever did what was originally called `counsellor_reset_submission()`,
clearing submitted answers while keeping the account (students row)
intact. There was no way to actually remove a student's name from
the database at all. Two now-distinct actions exist everywhere a
delete-like action appears (table rows, the detail view, the bulk
bar):

- **"Clear data"** (amber) — unchanged behavior, just renamed for
  clarity now that "Delete" means something else: resets to an
  editable draft, keeps the account.
- **"Delete"** (red) — new, genuinely irreversible. New SQL function
  `counsellor_delete_student()` in
  `supabase/counsellor_delete_student.sql` — **must be run manually
  in the Supabase SQL Editor before this button will work**, same as
  every other schema change in this project; I can't execute SQL
  against the live database myself.

**Verified the schema before writing the delete cascade**, not
assumed: checked `future_pathways_schema.sql` directly and confirmed
`students.id`/`app_users.id` already `references auth.users(id) on
delete cascade`, and `future_pathways.student_id`/the three
preference tables' `future_pathway_id` all cascade the same way —
meaning the whole chain from `auth.users` down would already clean
itself up automatically. Wrote the explicit multi-step deletes
anyway (preferences → future_pathways → students → app_users →
auth.users) rather than relying silently on the cascade — harmless
given it's already guaranteed correct, and self-documenting about
exactly what a "delete" removes for anyone reading the function
later. Added a defensive guard against a counsellor deleting their
*own* account through this path, given the operation is irreversible.

Same SECURITY DEFINER pattern already proven in
`counsellor_create_student()` (which inserts into `auth.users` the
same way this deletes from it) — not a new technique, reusing what's
already known to work.

**Bulk stays "Clear data for selected", deliberately not upgraded to
bulk-delete** — accidentally permanently deleting several real
accounts at once in one click is a meaningfully bigger mistake than
doing it one at a time, and this wasn't explicitly asked for. Bulk
bar's color/styling switched from red to amber to match its actual
(safer) behavior, since red now specifically means "irreversible"
elsewhere in the same table.

Verified via render: the two-button color distinction (violet Edit /
amber Clear data / red Delete) reads clearly at a glance, and the
delete confirmation dialog explicitly names what's removed, states
irreversibility plainly, and points to "Clear data" as the
alternative for anyone who clicked the wrong one.

## Bulk Actions Dropdown: "Clear data" and "Delete" for selected students

Direct feedback: when multiple or all students (e.g. 95 students) are
selected via select-all, the user expected an Actions dropdown menu
offering both "Clear data" (reset to draft) and "Delete" (permanently
delete student accounts) rather than solely offering a single clear-data
action.

- Added an **Actions Dropdown menu** (`#fp-bulk-dropdown-toggle` and
  `#fp-bulk-dropdown-menu`) directly in the `#fp-bulk-actions` bar.
- Includes two clearly delineated options:
  - 🟠 **Clear data for selected** — batch resets forms to editable
    drafts while keeping accounts intact via `counsellor_reset_submission`.
  - 🔴 **Delete selected** — batch permanently deletes student
    accounts and all submitted data from the database via `counsellor_delete_student`.
- Also provided direct quick-action links (`Clear data` and `Delete`) on
  the bulk bar for immediate 1-click access.
- Enhanced confirmation dialogs for batch operations to list student names
  and explicitly differentiate between resetting drafts vs permanent deletion.
- Added loading/disabled states during batch execution and ensured
  `renderStatsStrip()` is called after all batch and individual delete/reset
  operations to keep total, submitted, and draft metrics synchronized.

## Full SaaS UI/UX Overhaul: Toasts, Sortable Table, Pagination, CSV Export, Unified Shell

Direct review and critique on product UI/UX led to a comprehensive SaaS upgrade:

1. **Toast Notification System (`js/fp-toast.js`)**:
   - Replaced all crude, blocking browser `alert(...)` dialogs with theme-aware, animated toast notifications (`FP.toast.success`, `FP.toast.error`, `FP.toast.info`, `FP.toast.loading`).
   - Non-blocking, smooth entry/exit animations, loading spinners, and dismiss triggers.

2. **Admin Data Table Supercharge (`admin.html`, `js/fp-admin.js`)**:
   - **Clickable Sortable Columns**: Click table headers (Student, Pathway, First Priority, Status, Submitted) to toggle ascending/descending with arrow indicators (▲ / ▼ / ⇅).
   - **Pagination Toolbar**: Page size selector (25, 50, 100, All), Previous / Next buttons, and live `Showing 1–25 of 95 students` metrics.
   - **Faceted Active Filter Chips**: Clickable filter chips showing active queries with individual `✕` removal and a 1-click `Clear filters` button.
   - **CSV Export**: One-click `Export CSV` button that downloads all current filtered/selected student records into an RFC-compliant `.csv` file.
   - **Rich Empty State**: Beautiful empty search state with illustration and reset CTA when no students match filters.

3. **Unified Navigation & Role-Based Routing**:
   - Active navigation highlighting (`.nav-link.is-active`) across all pages so users always know their location.
   - Role-based smart routing: Counsellors/admins landing on `login.html` are routed directly to the management hub (`admin.html`).
   - Integrated `js/fp-toast.js` across every page.



