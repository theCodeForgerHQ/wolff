import { bootstrap } from './bootstrap';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = bootstrap(config);

export default app;
