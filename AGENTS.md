# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript/React Obsidian plugin. `src/main.ts` owns plugin lifecycle, while the top-level `src/*View.tsx` files render calendar views. Place modal UI in `src/modals/`, settings and defaults in `src/settings/`, date helpers in `src/util/`, and indexing or holiday logic in `src/services/` and its focused subdirectories. Keep plugin metadata in `manifest.json`, bundling in `esbuild.config.mjs`, compiler settings in `tsconfig.json`, and CSS in the root stylesheets or `src/styles/`. There is currently no test directory. `main.js` is generated and ignored.

## Build, Test, and Development Commands

- `npm install` — install dependencies.
- `npm run dev` — run esbuild in watch mode with inline sourcemaps.
- `npm run build` — type-check with TypeScript, then create the production bundle at `main.js`.
- `./node_modules/.bin/eslint src` — lint TypeScript and TSX sources using the repository ESLint configuration.

No automated test framework or `npm test` script is configured. For manual verification, build the plugin and copy `main.js`, `manifest.json`, and applicable stylesheets into `<Vault>/.obsidian/plugins/<plugin-id>/`, then reload Obsidian and exercise the changed view, settings, and note interactions.

## Coding Style & Naming Conventions

Respect `.editorconfig`: use tabs with a four-space width, LF line endings, and a final newline. Use TypeScript types and existing compiler checks; keep components and classes in PascalCase, functions and variables in camelCase, and service/type filenames descriptive and PascalCase. Keep modules focused, match surrounding quote conventions, and handle asynchronous or Obsidian event work with cleanup-safe APIs such as `registerEvent` and `registerInterval`.

## Testing Guidelines

Treat `npm run build` as a required pre-PR check and run ESLint as a pre-PR diagnostic. The current baseline contains lint errors, so avoid introducing new ones and call out any related existing failures. Since there are no unit tests or coverage thresholds, describe manual Obsidian testing in the pull request. Include screenshots or a short recording for UI changes.

## Commit & Pull Request Guidelines

Recent commits use short, informal, lowercase summaries such as `styling things` and `check point`. Prefer a concise imperative subject that explains the change, for example `fix recurrence date rendering`, and keep commits focused. Pull requests should include a summary, validation commands and manual scenarios, relevant issue or context, and screenshots for visual changes. Do not commit `node_modules/`, generated `main.js`, vault `data.json`, or other ignored artifacts.
