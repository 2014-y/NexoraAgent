const s = require("node:sqlite");
const db = new s.DatabaseSync(":memory:");
console.log("Real sandbox node version:", process.version);
console.log("Real sandbox sqlite version:", db.prepare("SELECT sqlite_version() AS version").get());
process.exit(0);
