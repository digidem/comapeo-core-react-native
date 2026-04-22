import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { T } from '@/lib/theme';

export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.root}>
      <ActivityIndicator color={T.primary} size="small" />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingVertical: 80,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: T.bg,
    flex: 1,
  },
  label: {
    fontSize: 14,
    color: 'rgba(0,0,0,0.5)',
    fontFamily: T.font,
  },
});
