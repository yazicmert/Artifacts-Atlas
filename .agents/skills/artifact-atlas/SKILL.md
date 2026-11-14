---
name: artifact-atlas
description: Shows what this AI coding app (Claude Code, Codex or Cursor) has left on the user's disk, such as session records, caches, logs, screenshots and scratch files, with sizes, cleanup risk and the sessions that left the most behind. Use when the user asks what you or this app left behind, how much space your sessions take, what a session created, or wants to see their AI leftovers. Read only; it never moves or deletes anything.
---

# Artifact Atlas: what this app left behind

Artifact Atlas measures what an AI app leaves on disk and ties files to the sessions that made them. This skill runs its read-only summary from this clone and shows it in the chat.

## Steps

1. **Ask first.** The command reads this app's folders in the user's home folder: file names, sizes and dates, and the app's session records for their structure only (session IDs, times, tool names, file paths). It never prints or stores conversation text, and it writes nothing. Ask the user once in this conversation whether that is fine. Do not run it before they say yes.

2. **Run the summary** with Node.js 22.13 or newer. The script is `scripts/leftovers.mjs` in this skill's folder (`${CLAUDE_SKILL_DIR}` in Claude Code; elsewhere, the folder this file is in).

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/leftovers.mjs" --app claude --read-home
   ```

   If that path comes out empty (the app did not fill in `${CLAUDE_SKILL_DIR}`), run it from the clone's root instead:

   ```bash
   node .claude/skills/artifact-atlas/scripts/leftovers.mjs --app claude --read-home
   ```

   - `--app`: the app you are running in: `claude` (Claude Code), `codex` (Codex) or `cursor` (Cursor).
   - This session only: add `--session "${CLAUDE_SESSION_ID}"` in Claude Code (an empty value means the whole app). In another app, add `--project "<this project's folder>"` to see the sessions that ran in this project.
   - Paths, and session titles where the app's record names one: add `--details` only when the user asks for them. They are left out by default because this output is sent to the AI provider with the rest of the chat.
   - `--ascii` draws the bars with `#` if the chat shows boxes instead of blocks.
   - `--json` gives the same summary as JSON. `--unused-days 90` or `180` changes what counts as unused.

3. **Report** in the user's language. Show the summary's sections with their bars as they are, inside a code block so the columns stay aligned; translate the headings if you like, but do not redraw or round the bars. Then say in a few lines what stands out: the total, what is safe to remove, the largest kinds and the sessions that left the most. Say the counts are lower bounds. A session marked "may still be running" is likely this one.

## Rules

- View only. Never delete, move or `rm` the files this lists, and do not run Artifact Atlas's `quarantine` command for the user. To clean up, point them to the Artifact Atlas app (https://yazicmert.github.io/basket/): files go to its Quarantine first and can be put back.
- Never read session transcripts or quote prompts to describe a session; use the labels the summary gives.
- Do not pass `--read-home` without the user's yes, and do not add it to any allow list.
