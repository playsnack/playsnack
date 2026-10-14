// api/ev.js as the Pages Function runs it (see adapter.js).
import { createHandler as raw } from '../../ev.js';
import { viaPages } from './adapter.js';
export * from '../../ev.js';
export { default } from '../../ev.js';
export const createHandler = viaPages(raw);
