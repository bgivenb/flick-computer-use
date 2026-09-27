# App guides

Small, reusable instructions for the app or page Flick is currently using. Guides explain interface behavior and useful outcome checks; Jev still chooses from the current observed actions.

The initial library covers Notes, Messages, TextEdit, Finder, Calendar, Chrome, Google Search, LinkedIn posts, and web forms. Each guide contains at most six instructions. A guide loads when the current observation matches one of its bundle IDs, hostnames, or control roles. The loader prefers app/site guides over role guides and includes at most three guides, six entries per guide, and 3,000 instruction characters in total.

## Evidence and status

- `documented`: written guidance supported by a cited source. Application behavior cites primary documentation from Apple, Google, LinkedIn, or MDN. Flick workflow advice cites project code and explicitly notes that it has not been validated live in that app.
- `validated`: a lesson confirmed by an observed successful interaction. Include the applicable context and outcome evidence.
- `suggested`: an unverified proposal, including a possible lesson from a failure. Keep it for review; it does not enter Jev's working context.

These bundled guides are documented starting points, not claims that every workflow has passed a live test. Interface labels and behavior can change by app version, account, language, or layout. Fresh observed controls and outcomes determine the action.

## Adding or improving a guide

Use a narrow trigger and describe a reusable relationship, such as “the recipient field and the message composer are different controls.” Prefer a short instruction and the evidence that shows it worked. Do not store user messages, contact details, credentials, record values, screenshots, or a whole failed trace in a shared guide.

A failure is useful evidence about what happened, but does not establish its cause. Record a specific proposed correction as `suggested`. After a successful retry verifies the correction, an agent can promote the lesson to `validated`. Keep failed and successful outcomes distinguishable so a temporary loading delay does not become a permanent application rule.

The host agent can maintain local lessons through MCP:

1. Call `computer_guide_read` with no arguments to list guide metadata, with `id` to read one guide, or with `targetId`, `url`, and/or `roles` to find relevant guides.
2. Call `computer_guide_update` with `guide` and `expectedVersion` from the read result; use `0` for a new guide. Instructions merge by their stable IDs, so omitted entries are preserved.
3. For new local entries, set provenance source to `agent` or `user`, include outcome evidence, and use `suggested` or `validated`. Promoting a failed attempt's proposal requires successful evidence and `outcome: "success"`.

Local updates are stored under the configured local directory's `app-guides` folder, normally `.local/app-guides`. They do not change these bundled files or publish anything to GitHub. To contribute a generally useful lesson, remove session-specific data and propose an edit to the matching bundled guide.

Example:

```json
{
  "schemaVersion": 1,
  "id": "example-app",
  "name": "Example app",
  "version": 1,
  "match": { "hosts": ["example.com", "*.example.com"] },
  "instructions": [
    {
      "id": "confirm-selection",
      "text": "After entering a search term, choose the matching observed suggestion and verify the selected value before continuing.",
      "status": "suggested",
      "provenance": {
        "source": "agent",
        "evidence": "Typing left the field unresolved; a suggestion list was still visible. This correction has not yet been tested."
      },
      "outcome": "failure"
    }
  ]
}
```

Bundle IDs and roles match explicitly. Hostnames match exactly; `*.example.com` covers subdomains and `example.com` covers the apex. Match alternatives use OR. Keep role-based guides generic because many unrelated apps expose the same role. The web-form guide uses browser roles rather than raw macOS Accessibility roles.

Use stable lowercase IDs with hyphens, increment a guide's version when changing it, and retain provenance. Instructions are limited to 600 characters each. Avoid fixed coordinates, guessed element IDs, selectors, scripts, and tool names that the current driver does not offer. Instructions assist the current task; they do not establish a recipient, permission to publish, or a claim of task completion.

The source URL and rationale live with each instruction in its JSON file. This keeps documentation-backed behavior distinct from project guidance and later runtime evidence.
