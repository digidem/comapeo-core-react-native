import { StyleSheet, Text, View } from 'react-native';

import { SCHEMA_COLORS } from '@/lib/theme';

type Props = {
  schemaName: string;
};

export function SchemaBadge({ schemaName }: Props) {
  const color = SCHEMA_COLORS[schemaName] ?? '#6B7280';
  return (
    <View style={styles.root}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{schemaName.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
});
