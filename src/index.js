import { app } from './server.js';
import { initStore } from './store.js';

const PORT = process.env.PORT || 4000;

await initStore();
app.listen(PORT, () => {
  console.log(`Ludwitt/Hult API on http://localhost:${PORT}`);
});
