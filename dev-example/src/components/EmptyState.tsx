import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { T } from '@/lib/theme';

type Props = {
  title: string;
  icon?: string;
  action?: React.ReactNode;
};

export function EmptyState({ title, icon = '○', action }: Props) {
  return (
    <View style={styles.root}>
      <View style={styles.iconWrap}>
        <Text style={styles.icon}>{icon}</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 56,
    paddingHorizontal: 24,
    gap: 10,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Platform.select({ ios: 'rgba(60,60,67,0.08)', default: 'rgba(23,29,27,0.08)' }),
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 22,
    color: 'rgba(0,0,0,0.3)',
  },
  title: {
    fontSize: 16,
    fontWeight: '500',
    color: T.textMuted,
    fontFamily: T.font,
  },
});
