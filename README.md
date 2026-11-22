# Personal Runtipi app store

- `immich-screenshot-filer`: files iPhone/Mac screenshots in Immich into an album and archives them.
  Source is `src/filer.ts` (Bun + TypeScript, no dependencies). It is inlined into
  `apps/immich-screenshot-filer/docker-compose.yml`, so after editing it run `bun scripts/inline.ts`.
- `immich-trip-digest`: suggests `YYYY-MM Place` albums for unsorted trip photos (you approve each on its page)
  and posts a monthly library digest to Immich's notification bell. Source is `src/trip-digest.ts`; after
  editing it run `bun scripts/inline-trip-digest.ts`. Optional Dry run writes nothing to Immich.
- `pdf-unlocker`: unlocks password-protected PDFs in watched Nextcloud folders (WebDAV + Stirling-PDF) and
  replaces them in place under the same name. Source is `src/pdf-unlocker.ts`; after editing it run
  `bun scripts/inline-pdf-unlocker.ts`. Tests: `bun test` (fake Nextcloud + Stirling, also runnable against
  the inlined script with `UNLOCKER_SCRIPT=<file>`). Also renames ADCB card statements to include the card
  number (`RENAME_MODE`). Unlock and rename each start in dry run.

Runtipi only offers an Update (and a new settings form) when `tipi_version` in `config.json` goes up, so bump it
together with `version` on every change to an app.
