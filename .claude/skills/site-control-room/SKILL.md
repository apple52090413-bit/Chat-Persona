---
name: site-control-room
description: Survey a website project's infrastructure (Git host, backend/API host, domain registrar/DNS, payment or other integrations, file layout) and publish it as a private "control room" reference Artifact — key facts, common maintenance steps, and quick links per service, color-coded for fast scanning. Use whenever the user wants to check up on, maintain, hand off, or get oriented in a website project; asks for a "control room", "status page", "整理", "檔案地圖", or similar; juggles multiple sites and needs to track accounts/configs across them; or is about to touch infra (DNS, secrets, redeploys) on a project not yet covered this session. Also use proactively right after a first deploy, so the reference exists before it's needed. Works for any hosting/backend/registrar combo — survey what's actually in the repo, don't assume a specific stack.
---

# Site Control Room

Non-technical people who build small sites end up with the actual knowledge of "how this works" scattered across a Git host, a backend/API host, a domain registrar, and whatever files are in the repo — plus a pile of chat history that explains none of it six months later. This skill turns that scattered state into one page they can bookmark: a private Artifact that says, per service, what it's for, the facts that matter, and the exact steps for the tasks that come up again and again (redeploy, rotate a secret, fix DNS).

The reader of the output is very likely not a developer. Don't assume terminal/CLI access unless the repo shows real evidence it's actually used that way (e.g. a `wrangler.toml` with a filled-in ID, not just present because it's part of a template). Write every step as something doable by clicking around a web dashboard, in plain language, no unexplained jargon.

## When you run this

### 1. Survey the project

Look at what's actually in the repo — don't assume any particular stack. Things to check for for:

- **Git/hosting host**: which platform (GitHub, GitLab, …), repo visibility, default/production branch, whether there's a separate dev branch and what the merge convention is, and how deploys are triggered (a CI workflow file like `.github/workflows/*.yml`, a host's own auto-deploy-on-push, or something manual).
- **Backend / API**: look for a `worker/`, `api/`, `server/`, `functions/`, or similar directory; config files that name the host (`wrangler.toml` → Cloudflare Workers, `vercel.json` → Vercel, `netlify.toml` → Netlify, etc.); a single-file "bundle" build artifact meant for pasting into a web dashboard editor (a sign the user has no terminal — note this, it changes how you write the maintenance steps); env/secret names referenced in code (list the *names* only, never chase down or print actual values); a database binding or connection string (name and purpose, not credentials).
- **Domain / DNS**: a `CNAME` file, custom-domain settings, or any doc/comment naming a registrar. If you don't have direct access to the registrar, use whatever the conversation history or repo comments already established rather than guessing.
- **Payment or other third-party integrations**: payment gateway code, webhook handlers, anything with an application/approval status that's still pending — capture the status as of now, since that's exactly the kind of thing that's easy to forget about.
- **File layout**: the handful of files that actually matter to someone maintaining this — main site file(s), admin/backend entry points, deploy scripts, schema files, the README if there is one. Skip node_modules-style noise.

Pull concrete facts (exact repo names, URLs, file paths, service names) — a reference page full of vague placeholders defeats the purpose. If something is genuinely unknown, say so explicitly in the page rather than guessing or omitting it silently.

**Never include actual secret values** — passwords, API keys, hash keys, tokens. Reference *where* a secret lives ("stored as a Cloudflare Secret") and never its value, even if you can technically see it. This page may get shared later; treat it as if it already has been.

### 2. Check for an existing control room before creating a new one

This environment resets between sessions — nothing on local disk survives except what's committed to the repo. So the pointer to an existing Artifact has to live *in the repo*, not in a local file. Look for a tracked file named `CONTROL_ROOM.md` at the repo root. If it exists, it holds the Artifact's URL — read it and pass that URL to the `Artifact` tool's `url` parameter so you *update* the existing page in place instead of creating a duplicate one. If it doesn't exist, this is the first run for this project: you'll create it after publishing (step 4).

### 3. Write the page

Read the `artifact-design` skill before writing (this is a real design pass, not boilerplate — do it even though the visual language below is intentionally similar every time). Treat this as a **utilitarian reference**, not an editorial/marketing piece: real typographic hierarchy and a considered palette, but no giant hero, no flashy motion.

`references/example-control-room.html` in this skill is a complete worked example, built for a real project (a chat-analysis site called Chat Persona, on GitHub + Cloudflare Workers + GoDaddy). Read it for the layout pattern:

- A short header (project name, one-line orientation sentence, last-updated date)
- A horizontal row of jump links, one per service, each with a small color dot
- One card per service, left-bordered in that service's accent color, containing: a facts list (`<dl>` of label/value pairs), a "common tasks" numbered list with concrete click-by-click steps, and a row of quick-link chips
- A file-map block in a monospace font for the repo layout
- A closing decisions/status log for things worth remembering later (open questions, pending approvals, choices made and why)

Adapt it, don't reuse it verbatim — the whole point of the color-coded service cards is that each one is a distinct real system, so build the actual set of cards this project needs (it might be three services, or it might be six, or it might have no payment integration at all — omit sections that don't apply rather than leaving a hollow placeholder card). Keep the same spirit: a small set of named accent colors used as a wayfinding device across sections, one typeface pairing (a serif for headings reads well against a sans body, per the example, but pick what fits — the point is a deliberate pairing, not a copy-paste of the exact fonts), full support for both light and dark viewer themes per the artifact-design rules.

Write every "common task" as an actual sequence of clicks/steps, not a description of what's possible — "Settings → Secrets → Add" beats "you can add secrets in the settings."

### 4. Publish and record the pointer

Publish with the `Artifact` tool (private by default — that's correct, don't change it). Then:

- **First run**: after publishing, write the returned URL into a new `CONTROL_ROOM.md` at the repo root — just the URL and a last-updated line is enough, a human might open this file directly so keep it readable. Commit and push it (same branch conventions as the rest of the user's workflow in that repo — check CLAUDE.md or recent commit history if unsure). Tell the user this file now exists and is how future sessions will find the page again.
- **Update run**: republish to the same URL (pass `url` to the `Artifact` tool), then update the "last updated" line in `CONTROL_ROOM.md` and commit/push that.

### 5. Tell the user what changed

Keep this short. Say what's new or updated since last time (if anything material changed — new service, status change, newly discovered facts), and hand them the link. Don't re-explain the whole page back to them; they're about to look at it themselves.
