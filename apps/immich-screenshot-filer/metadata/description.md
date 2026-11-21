# Immich Screenshot Filer

Every minute, checks images that were added or changed in Immich for Apple's screenshot marker
(the EXIF UserComment "Screenshot" that iPhone, iPad and Mac write, which stays when a screenshot is cropped).
Matches are added to the chosen album and archived, so they leave the main timeline.

On first start it also checks the whole timeline once.

Images without the marker (photos, bank slips saved by apps, downloaded images) are never touched.
Set **Dry run** to see in the logs what it would do without changing anything.
