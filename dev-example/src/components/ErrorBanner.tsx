import { Platform, StyleSheet, Text, View } from 'react-native';

import { T } from '@/lib/theme';

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.root}>
      <Text style={styles.text}>
        <Text style={styles.bold}>Error</Text> · {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 12,
    borderRadius: Platform.select({ ios: 10, default: 4 }),
    backgroundColor: 'rgba(220,38,38,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.18)',
  },
  text: {
    fontSize: 13,
    lineHeight: 18,
    color: '#991B1B',
    fontFamily: T.font,
  },
  bold: { fontWeight: '600' },
});
