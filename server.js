import { createApp } from "./src/app.js";

const PORT = process.env.PORT || 3000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`misa.lol running at http://localhost:${PORT}`);
  console.log(`Editor:  http://localhost:${PORT}      (login as nova)`);
  console.log(`Admin:   http://localhost:${PORT}/admin.html   (login as admin)`);
  console.log(`Public:  http://localhost:${PORT}/p/nova`);
});