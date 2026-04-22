import { Platform, StyleSheet, Text, View } from 'react-native';

type Props = {
  bg: string;
  ch: string;
  size?: number;
  radius?: number;
};

// Square / rounded leading icon — colored fill + 1-2 char initial in white.
export function Glyph({ bg, ch, size = 32, radius }: Props) {
  return (
    <View
      style={[
        styles.root,
        {
          width: size,
          height: size,
          borderRadius: radius ?? size / 2,
          backgroundColor: bg,
        },
      ]}
    >
      <Text style={[styles.label, { fontSize: Math.max(12, size * 0.42) }]}>{ch}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  label: {
    color: '#fff',
    fontWeight: '600',
    fontFamily: Platform.select({ ios: 'System', default: 'Roboto' }),
  },
});
