// api/room-result.js as the Pages Function runs it (see adapter.js).
import { createHandler as raw } from '../../room-result.js';
import { viaPages } from './adapter.js';
export * from '../../room-result.js';
export { default } from '../../room-result.js';
export const createHandler = viaPages(raw);
