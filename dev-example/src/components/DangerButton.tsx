import { Platform, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { T } from '@/lib/theme';

type Props = {
  children: string;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function DangerButton({ children, onPress, disabled, style }: Props) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
      style={({ pressed }) => [
        styles.root,
        { opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      <Text style={styles.label}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: Platform.select({ ios: T.card, default: 'transparent' }),
    paddingVertical: Platform.select({ ios: 14, default: 10 }),
    paddingHorizontal: Platform.select({ ios: 14, default: 24 }),
    borderRadius: T.buttonRadius,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: Platform.select({ ios: 48, default: 40 }),
    borderWidth: Platform.select({ ios: 0, default: 1 }),
    borderColor: 'rgba(23,29,27,0.2)',
  },
  label: {
    color: T.danger,
    fontSize: Platform.select({ ios: 16, default: 14 }),
    fontWeight: Platform.select({ ios: '500', default: '500' }),
    fontFamily: T.font,
  },
});
