# Repository Guidelines

## Project Structure & Module Organization
- Source lives in `src/`; `src/index.js` hosts the HTTP server and inline UI, while `src/awsDiscovery.js` builds the AWS relationship graph and `src/serviceColors.js` centralizes palette data.
- Temporary unzip artifacts from Lambda bundles land in `tmp/`; clean it when testing new discovery paths.
- There is no separate frontend build directory—the HTML scaffold is rendered directly from the Node server.

## Build, Test, and Development Commands
- `npm install` installs the AWS SDK clients, ZIP tooling, and shared dependencies.
- `npm start` runs the production-style server on port 3000 using your active AWS profile.
- `npm run dev` mirrors `start` but sets `NODE_ENV=development` so verbose validation messages are emitted.
- When iterating on discovery logic, remove stale files in `tmp/` to trigger a fresh download and scan of Lambda code.

## Coding Style & Naming Conventions
- Code targets Node 18+ with ES modules; prefer named `import`/`export` and keep modules cohesive by feature (`GraphBuilder`, `serviceColors`).
- Follow the existing 2-space indentation, single-quoted strings, and compact object literals without trailing commas.
- Add new AWS service colors in `src/serviceColors.js` and map canonical names in `serviceNameMap` inside `src/awsDiscovery.js`.

## Testing Guidelines
- Automated tests are not yet in place; validate changes by running `npm start` and visiting `http://localhost:3000` to inspect the graph, validation list, and warnings.
- For new discovery heuristics, capture the generated JSON or screenshots and share them in the PR to document expected behavior.
- Respect the archive size guards (`MAX_*` constants in `src/awsDiscovery.js`) and log validation steps for any new flows so regressions surface in the UI.

## Commit & Pull Request Guidelines
- Use short, imperative commit messages (`Add search`, `Update service handling`) and keep unrelated changes out of the same commit.
- PR descriptions should summarize the feature or fix, list manual verification steps, and link issues when available.
- Attach screenshots or JSON excerpts whenever the rendered graph or validation output changes to aid reviewers.

## AWS Access & Security
- Credentials resolve via `fromNodeProviderChain`; rely on ephemeral profiles or SSO where possible and avoid hard-coding secrets.
- Never commit Lambda bundles or extracted artifacts—ensure anything added to `tmp/` or similar scratch space stays untracked.
- Scrub logs and validation messages for sensitive ARNs before sharing externally.
