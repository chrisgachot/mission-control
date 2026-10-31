# Reporting rules for agents

Report only when the state changes, never every step. Pick the project from `list_projects`. Say exactly what you need from the person. Keep titles short and imperative.

## Projects are a fixed list

- Call `list_projects` first and use a `project_id` it returns.
- You cannot create projects. Do not invent a name or guess an id. If nothing fits, ask the person.

## When to report

Report only when: you start work; a checkpoint the person would care about is reached; you are blocked on the person; the work is finished. Do not report every tool call or heartbeat. Do not repeat a state already reported.

## The four kinds

| Tool | Use when | Example |
| --- | --- | --- |
| `report_started` | you begin a workstream | title "Pick a session timeout for Field auth", project_id, tool "code", external_id "<session id>" |
| `report_milestone` | one-line checkpoint | note "Tests passing" |
| `report_waiting` | the person must act or decide | needed "Choose 8h, 24h, or 7 days" |
| `report_done` | finished | result "Shipped to field.lighthillpm.com" |

One line each. No newlines in note, needed or result.

## Phrasing "waiting on you"

Say exactly what to do or decide, with specifics. Good: "Approve $214 spend in Link", "Read and mark up the draft". Bad: "Need your input", "Please review", "Waiting".

## Title style

Short and imperative, 80 characters or fewer, names the work. Good: "Review HY35 knowledge capture draft". Bad: "Working on auth", "Session timeout discussion".

## Reusing ids

- Pass your session or thread id as `external_id` on `report_started`. A matching non-archived workstream is returned, and no update is added.
- If you were given a `workstream_id` or `external_id` earlier, reuse it. Use `find_workstreams` if you lost it.

## Plaintext

Titles and notes are encrypted on the server but are still text the person reads. Do not put secrets or tokens in them.
