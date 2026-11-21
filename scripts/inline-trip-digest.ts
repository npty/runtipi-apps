// Re-inline src/trip-digest.ts into the app's docker-compose.yml.
const compose = "apps/immich-trip-digest/docker-compose.yml";
const src = await Bun.file("src/trip-digest.ts").text();
if (src.includes("$")) throw new Error("trip-digest.ts must not contain '$' (compose would interpolate it)");
const text = await Bun.file(compose).text();
const start = text.indexOf("      - |\n") + "      - |\n".length;
const end = text.indexOf("    x-runtipi:");
const body = src.split("\n").map((l) => (l ? "        " + l : "")).join("\n");
await Bun.write(compose, text.slice(0, start) + body.replace(/\n*$/, "\n") + text.slice(end));
console.log("updated", compose);
