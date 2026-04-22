import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { FAB_SHADOW } from '@/lib/theme';

type Props = {
  label: string;
  onPress?: () => void;
};

// Material 3 extended FAB. Renders only on Android — iOS uses a header "+" button.
export function FAB({ label, onPress }: Props) {
  if (Platform.OS !== 'android') return null;
  return (
    <View style={styles.host} pointerEvents="box-none">
      <Pressable
        android_ripple={{ color: 'rgba(0,0,0,0.12)' }}
        onPress={onPress}
        style={[styles.root, FAB_SHADOW]}
      >
        <Text style={styles.plus}>＋</Text>
        <Text style={styles.label}>{label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    right: 16,
    bottom: 24,
  },
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 56,
    paddingHorizontal: 20,
    backgroundColor: '#9cf1e1',
    borderRadius: 16,
  },
  plus: { fontSize: 22, color: '#00201c' },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#00201c',
    fontFamily: 'Roboto',
  },
});
