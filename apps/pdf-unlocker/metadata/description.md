# PDF Unlocker

Every 5 minutes, walks the watched Nextcloud folders (default `Area/Finance/Banking`), finds password-protected PDFs and unlocks them with Stirling-PDF. The unlocked file replaces the original under the same name; Nextcloud keeps the encrypted original as a file version.

- Passwords: one or more, separated by spaces, commas or semicolons. Each is tried in turn.
- Safe write-back: the file is only replaced if it has not changed since it was read, and only if the result is a complete, unencrypted PDF.
- Files no password opens are skipped and logged once, until the file changes.
- Start in **Dry run**: it decrypts to prove the chain works, logs what it would do, and changes nothing. Switch to **On** when the log looks right.
