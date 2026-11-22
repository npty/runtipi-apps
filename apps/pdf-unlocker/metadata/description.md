# PDF Unlocker

Every 5 minutes, walks the watched Nextcloud folders (default `Area/Finance/Banking`), finds password-protected PDFs and unlocks them with Stirling-PDF. The unlocked file replaces the original under the same name; Nextcloud keeps the encrypted original as a file version.

- Passwords: one or more, separated by spaces, commas or semicolons. Each is tried in turn.
- Safe write-back: the file is only replaced if it has not changed since it was read, and only if the result is a complete, unencrypted PDF.
- Files no password opens are skipped and logged once, until the file changes.
- Start in **Dry run**: it decrypts to prove the chain works, logs what it would do, and changes nothing. Switch to **On** when the log looks right.

**Naming ADCB card statements:** statements saved from several cards in one month collide on file name (`... Card Statement (2).pdf`). The unlocker reads page 1 through Stirling and renames `2026-10 - ADCB - Card Statement (3).pdf` to `2026-10 - ADCB 2418 - Card Statement.pdf` (card from the masked number, month from the statement date). It never overwrites an existing file. The rename has its own Dry run / On switch.
