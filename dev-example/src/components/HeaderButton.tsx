import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { T } from '@/lib/theme';

type Props = {
  label: string;
  onPress?: () => void;
};

// A consistent text-button for native stack header `headerRight` slots.
// iOS: tinted text. Android: tinted text in caps via M3 convention.
export function HeaderButton({ label, onPress }: Props) {
  return (
    <Pressable hitSlop={8} onPress={onPress}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    color: T.primary,
    fontSize: Platform.select({ ios: 17, default: 14 }),
    fontWeight: Platform.select({ ios: '500', default: '500' }),
    paddingHorizontal: 4,
  },
});
