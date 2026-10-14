import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetch, getVercelApp } = require('../server.js');

export default { fetch };
export const getApp = getVercelApp;
