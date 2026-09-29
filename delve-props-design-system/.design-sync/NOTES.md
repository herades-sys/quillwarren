# design-sync notes: Delve Props

- This folder is a Claude Design export (made in Cowork), uploaded as-is: shape "prebuilt", with no build or converter. The project is "Delve Props" (see config.json).
- The preview cards load no stylesheet of their own. They use `var(--parchment)`, `--ink`, `--paper`, `--shade`, `--label-ink`, `--grid-faint`, `--font-display` and `--font-mono`, which come from `styles.css`. Keep those names in styles.css, with the values from tokens.json.
- Don't upload `design-system.json`. It is the old project's own metadata, with blob ids that don't exist in this project.
- There is no `_ds_sync.json`, so every sync compares the whole folder. That's cheap: about 30 files.
- To sync a new batch (new `assets/<category>/*.svg`, a new card, manifest entries): compare the folder with GitHub and the project, then upload the new or changed files with the refresh marker `_ds_needs_recompile` written first and last.
