# Immich Screenshot Filer

Every minute, checks images that were added or changed in Immich and have no camera model.

- **Screenshots**: Apple's screenshot marker (the EXIF UserComment "Screenshot" that iPhone, iPad and Mac write, kept when cropped) -> screenshots album.
- **Bank/payment slips** (optional): bank-app file names (STKB…, TSKB…, FX…) or slip wording in Immich's OCR text ("scan this QR code to verify", "โอนเงินสำเร็จ", "รหัสอ้างอิง", …) -> slips album.

Matches are added to the album and archived, so they leave the main timeline. On start it checks the whole timeline once.
Each rule can run as a dry run first: it logs what it would do without changing anything.
