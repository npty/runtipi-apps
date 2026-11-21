# Personal Runtipi app store

- `immich-screenshot-filer`: files iPhone/Mac screenshots in Immich into an album and archives them.
  Source is `src/filer.ts` (Bun + TypeScript, no dependencies). It is inlined into
  `apps/immich-screenshot-filer/docker-compose.yml`, so after editing it run `bun scripts/inline.ts`.
