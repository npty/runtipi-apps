# Personal Runtipi app store

- `immich-screenshot-filer`: files iPhone/Mac screenshots in Immich into an album and archives them.
  Source is `src/filer.ts` (Bun + TypeScript, no dependencies). It is inlined into
  `apps/immich-screenshot-filer/docker-compose.yml`, so after editing it run `bun scripts/inline.ts`.
- `immich-trip-digest`: suggests `YYYY-MM Place` albums for unsorted trip photos (you approve each on its page)
  and posts a monthly library digest to Immich's notification bell. Source is `src/trip-digest.ts`; after
  editing it run `bun scripts/inline-trip-digest.ts`. Optional Dry run writes nothing to Immich.
