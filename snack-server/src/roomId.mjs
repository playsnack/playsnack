// Room ids as the server sees them (pure; tested in snack-server/test/roomId.test.mjs).
//   <app slug>          the app's public room
//   <app slug>~<CODE>   a friends-only room (snack-player/src/links.ts)
// The app slug is what the registry, stats and defaults key on; the full id is
// what the engine, the relay and the sockets key on.

/** What a room id may look like on the wire (ws hello, /api/events, ?room=): no slashes, no `..` paths. */
export const ROOM_ID_RE = /^[\w.~-]{1,80}$/;
export const isRoomId = (s) => typeof s === "string" && ROOM_ID_RE.test(s);

export const appSlugOf = (roomId) => String(roomId).split("~")[0];
export const isFriendRoom = (roomId) => String(roomId).includes("~");

/** `?room=` on /api/apps/:slug: only a room of that app; anything else is the public room. */
export function roomIdForApp(slug, roomParam) {
  return isRoomId(roomParam) && appSlugOf(roomParam) === slug ? roomParam : slug;
}

/** Sum over a map keyed by room id, for every room of one app (public + friend rooms). */
export function sumRoomsOf(map, slug, sizeOf) {
  let n = 0;
  for (const [id, r] of map) if (appSlugOf(id) === slug) n += sizeOf(r);
  return n;
}
