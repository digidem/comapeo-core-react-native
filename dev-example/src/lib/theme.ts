import { Platform, type TextStyle, type ViewStyle } from 'react-native';

// CoMapeo brand greens
export const MAPEO = {
  primary: '#0E6B52',
  primaryDark: '#0A5842',
  primaryLight: '#DCEFE7',
} as const;

// Schema dot colors used in SchemaBadge / Glyph leading icons
export const SCHEMA_COLORS: Record<string, string> = {
  observation: '#0E6B52',
  track: '#0369A1',
  preset: '#A16207',
  field: '#7E22CE',
  icon: '#BE185D',
  projectSettings: '#52525B',
  deviceInfo: '#0891B2',
  remoteDetectionAlert: '#DC2626',
};

// Per-platform tokens — single source of truth for platform branching.
// Keep in sync with the design's `PLAT` constant in screens.js.
const IOS = {
  bg: '#F2F2F7',
  card: '#FFFFFF',
  cardRadius: 10,
  cardInsetH: 16,
  text: '#000000',
  textMuted: 'rgba(60,60,67,0.65)',
  textLabel: 'rgba(60,60,67,0.72)',
  textReadOnly: 'rgba(60,60,67,0.45)',
  separator: 'rgba(60,60,67,0.12)',
  separatorWidth: 0.5,
  primary: MAPEO.primary,
  font: Platform.select({ ios: 'System', default: 'System' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  buttonRadius: 12,
  rowChevron: 'rgba(60,60,67,0.3)',
  danger: '#DC2626',
  sectionLabelFontSize: 13,
  sectionLabelColor: 'rgba(60,60,67,0.6)',
};

const ANDROID = {
  bg: '#f4fbf8',
  card: 'transparent',
  cardRadius: 0,
  cardInsetH: 0,
  text: '#171d1b',
  textMuted: '#49454f',
  textLabel: '#006a60',
  textReadOnly: 'rgba(23,29,27,0.45)',
  separator: '#bec9c4',
  separatorWidth: StyleSheetHairline(),
  primary: '#006a60',
  primaryContainer: '#9cf1e1',
  onPrimaryContainer: '#00201c',
  surfaceContainer: '#eaf2ef',
  font: 'Roboto',
  mono: 'monospace',
  buttonRadius: 100,
  rowChevron: '#49454f',
  danger: '#ba1a1a',
  sectionLabelFontSize: 14,
  sectionLabelColor: '#006a60',
};

function StyleSheetHairline() {
  // Android divider hairline
  return Platform.OS === 'android' ? 1 : 0.5;
}

// Active token bag for the current platform.
export const T = Platform.OS === 'ios' ? IOS : ANDROID;

// Convenience: shadow style for floating action button on Android
export const FAB_SHADOW: ViewStyle = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 3 },
  shadowOpacity: 0.18,
  shadowRadius: 6,
  elevation: 3,
};

export const MONO_FONT: TextStyle = { fontFamily: T.mono };
