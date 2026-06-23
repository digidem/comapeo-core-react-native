// Fallback online map style used when the consuming app does not set
// `defaultOnlineStyleUrl` via the Expo plugin. Shared by createComapeo
// (MapeoManager's maps plugin) and createMapServer (the standalone map
// server the app fetches styles from) so the two can't drift.
export const DEFAULT_ONLINE_MAP_STYLE_URL =
  "https://demotiles.maplibre.org/style.json";
