# Changelog

All notable changes to the `angular-cli` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `angular-cli@<version>`.

## [Unreleased]

### Fixed
- Generators without a workspace project option, such as the `@angular/core` migrations (`standalone-migration`, `control-flow-migration`, `inject-migration`…), were refused by the CLI with *Unknown argument: project*: `--project` is now passed only to the schematics that declare it (`$default: projectName`), and the dialog shows the project choice only for them.

## [1.1.0] - 2026-11-13

### Added
- **component, service and module highlighted** at the top of the section, as large cards with their short command (`ng g c`, `ng g s`, `ng g m`); also first and highlighted in the dashboard widget.
- **Folder of the generated files**: in the dialog, the folder where the generator writes (the `path` option of the schematic), by default the project's own (`src/app`, `projects/<lib>/src/lib`). Typed with suggestions, or picked from the tree of the source folders; ↺ goes back to the default, it follows the workspace project while it is the default, and a new folder is created by the CLI. Shown under the field as the final path. Validated like the name (relative to the workspace, no `..`), passed as `--path` only when it differs from the default; also in the MCP tool `angular_cli_generate` (`folder`).

## [1.0.0] - 2026-11-12

### Added
- **Angular workspaces** among the projects: trait `angular` (`angular.json`), with the applications and libraries of the workspace, the Angular CLI and `@angular/core` versions installed in the project and the `schematics` defaults of `angular.json`. The CLI is always the project's own (`node_modules/@angular/cli`, run with Node and without a shell), never a global one; a project without `node_modules` shows *run npm install first*, with a button that does it when the NPM section is there.
- **Generators**: those of `@schematics/angular` (component, service, directive, pipe, guard, interceptor, resolver, class, interface, enum, module, environments, config…) and of the other installed collections (packages with a `schematics` field: Angular Material, NgRx, `@angular/core` migrations…), read from their `collection.json`; hidden and private ones left out. A filter, aliases, descriptions.
- **Generate dialog**: target project of the workspace, name with an optional path (`features/orders/order-list`), a form built from the generator's `schema.json` (choices, multiple choices, flags, text and numbers) with the `angular.json` defaults of the chosen project; only the changed options reach the CLI, in kebab-case, and every value is validated first (names without `..` or a leading `/`, choices, no option injection).
- **Preview with `--dry-run`**, rebuilt as the form changes: files that would be created or updated with their size, files that already exist with different content marked as conflicts (and *Generate* stopped); *Generate* runs the same command with its output live in the bottom panel and lists the files written.
- **Recent generators** per project (generator and options, without the name) to repeat one with a click; the last options used become the defaults of the dialog. Kept on this computer (`~/.kelbo/data/angular-cli`), not exported.
- **`ng add <package>`** (the package's own `ng-add` options as a form when it is already installed, otherwise `--defaults`) and **`ng update`**: the packages it can update, one or all, output live. Both ask first when the Git working tree has uncommitted changes, listing them (with a link to the Git section); `ng update` then runs with `--allow-dirty`.
- **Dashboard widget**: CLI version, quick generators (component, service, directive, pipe, guard) and the recent ones; a click opens the dialog.
- **MCP tools**: `angular_cli_workspaces`, `angular_cli_generators` (with their options), `angular_cli_generate` (a dry run unless `apply: true`, and only when the dry run is clean).
- With Kelbo 2.32, an *Angular CLI* button in the NPM and Git sections on Angular projects.
