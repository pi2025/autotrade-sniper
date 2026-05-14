# gstack

Use the `/browse` skill from gstack for all web navigation. Never use `mcp__claude-in-chrome__*` tools directly.

## Available gstack skills

- `/office-hours` — Structured office hours session
- `/plan-ceo-review` — CEO review of a plan
- `/plan-eng-review` — Engineering review of a plan
- `/plan-design-review` — Design review of a plan
- `/design-consultation` — Design consultation session
- `/design-shotgun` — Rapid design exploration
- `/design-html` — Generate HTML design
- `/review` — Code review
- `/ship` — Ship a feature
- `/land-and-deploy` — Land and deploy changes
- `/canary` — Canary deployment
- `/benchmark` — Run benchmarks
- `/browse` — Headless browser navigation and QA (use this for all web navigation)
- `/connect-chrome` — Connect to Chrome browser
- `/qa` — Full QA run
- `/qa-only` — QA without implementation
- `/design-review` — Review UI/UX design
- `/setup-browser-cookies` — Set up browser cookies
- `/setup-deploy` — Set up deployment
- `/setup-gbrain` — Set up gbrain
- `/retro` — Retrospective
- `/investigate` — Investigate an issue
- `/document-release` — Document a release
- `/codex` — Codex session
- `/cso` — Chief Strategy Officer review
- `/autoplan` — Automatically generate a plan
- `/plan-devex-review` — Developer experience review of a plan
- `/devex-review` — Developer experience review
- `/careful` — Careful mode for sensitive changes
- `/freeze` — Freeze a directory from edits
- `/guard` — Guard against unwanted changes

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
